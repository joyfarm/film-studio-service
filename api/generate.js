/* 대본 생성 API (방법 A): 로그인 확인 → 서버에 둔 스킬 규칙 + 요청을 Claude API에 보내고 결과를 한 줄씩(NDJSON) 흘려 보낸다.
   Edge 런타임: 긴 생성도 끊기지 않게 응답을 계속 이어서 보낼 수 있다.
   환경 변수: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, (선택) ALLOWED_EMAILS, CLAUDE_MODEL */
import { RULES } from './_rules.js';

export const config = { runtime: 'edge' };

const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const MAX_TOKENS = 8000;
const MAX_IDEA = 4000;

const json = (status, code, extra) => new Response(JSON.stringify(Object.assign({ code }, extra || {})), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});
const oneLine = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

function buildPrompt(idea, len, aud) {
  const hints = [];
  if (len) hints.push('길이: ' + len);
  if (aud) hints.push('대상: ' + aud);
  return '[요청]\n' + idea + (hints.length ? '\n\n[추가 조건]\n' + hints.join('\n') : '') +
    '\n\n위 요청으로 대본을 출력 형식 그대로 작성하세요.';
}

export default async function handler(request) {
  if (request.method !== 'POST') return json(405, 'method_not_allowed');

  const env = process.env;
  const missing = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'ANTHROPIC_API_KEY'].filter(k => !env[k]);
  if (missing.length) return json(500, 'server_misconfigured', { detail: '없는 환경 변수: ' + missing.join(', ') });

  // 1) 로그인한 사용자인지 확인 (Supabase가 토큰을 검증한다)
  const m = /^Bearer (.+)$/.exec(request.headers.get('authorization') || '');
  if (!m) return json(401, 'session_expired');
  let user;
  try {
    const ur = await fetch(env.SUPABASE_URL.replace(/\/$/, '') + '/auth/v1/user', {
      headers: { Authorization: 'Bearer ' + m[1], apikey: env.SUPABASE_ANON_KEY }
    });
    if (!ur.ok) return json(401, 'session_expired');
    user = await ur.json();
  } catch (e) { return json(502, 'upstream_error', { detail: 'Supabase에 연결하지 못했어요: ' + String((e && e.message) || e).slice(0, 120) }); }
  if (!user || !user.id) return json(401, 'session_expired');
  if (env.ALLOWED_EMAILS) {
    const ok = env.ALLOWED_EMAILS.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (!ok.includes(String(user.email || '').toLowerCase())) return json(403, 'forbidden', { detail: '허용 목록에 없는 이메일이에요: ' + String(user.email || '') });
  }

  // 2) 입력 검사
  let body = null;
  try { body = await request.json(); } catch (e) {}
  body = body && typeof body === 'object' ? body : {};
  const idea = String(body.idea == null ? '' : body.idea).trim();
  if (!idea) return json(400, 'empty_request');
  if (idea.length > MAX_IDEA) return json(413, 'prompt_too_large');
  const prompt = buildPrompt(idea, oneLine(body.len, 60), oneLine(body.aud, 60));

  // 3) Claude 호출
  const ac = new AbortController();
  request.signal.addEventListener('abort', () => ac.abort());
  let ar;
  try {
    ar = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ac.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, stream: true, system: RULES, messages: [{ role: 'user', content: prompt }] })
    });
  } catch (e) { return json(502, 'upstream_error', { detail: 'Claude에 연결하지 못했어요: ' + String((e && e.message) || e).slice(0, 120) }); }
  if (!ar.ok) {
    const code = ar.status === 429 || ar.status === 529 ? 'rate_limited' : ar.status === 413 ? 'prompt_too_large'
      : ar.status === 401 || ar.status === 403 ? 'server_misconfigured' : 'upstream_error';
    let msg = '';
    try { const j = await ar.json(); msg = (j && j.error && j.error.message) || ''; } catch (e) {}
    return json(502, code, { detail: 'Claude API ' + ar.status + (msg ? ': ' + String(msg).slice(0, 200) : '') });
  }

  // 4) 결과를 한 줄씩 흘려 보낸다: {"t":"d","x":"글자"} … {"t":"done","truncated":false}
  const enc = new TextEncoder(), dec = new TextDecoder();
  const stream = new ReadableStream({
    async start(controller) {
      const out = o => controller.enqueue(enc.encode(JSON.stringify(o) + '\n'));
      let buf = '', total = 0, stop = '', failed = '';
      const handle = line => {
        if (!line.startsWith('data:')) return;
        let d; try { d = JSON.parse(line.slice(5).trim()); } catch (e) { return; }
        if (d.type === 'content_block_delta' && d.delta && d.delta.type === 'text_delta' && d.delta.text) {
          total += d.delta.text.length; out({ t: 'd', x: d.delta.text });
        } else if (d.type === 'message_delta' && d.delta && d.delta.stop_reason) {
          stop = d.delta.stop_reason;
        } else if (d.type === 'error') {
          failed = d.error && d.error.type === 'overloaded_error' ? 'rate_limited' : 'upstream_error';
        }
      };
      try {
        const rd = ar.body.getReader();
        for (;;) {
          const { done, value } = await rd.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i).trim()); buf = buf.slice(i + 1); }
        }
        if (buf.trim()) handle(buf.trim());
      } catch (e) {
        if (!ac.signal.aborted) out({ t: 'e', code: 'upstream_error' });
        try { controller.close(); } catch (e2) {}
        return;
      }
      if (failed) out({ t: 'e', code: failed });
      else if (stop === 'refusal') out({ t: 'e', code: 'refused' });
      else if (!total) out({ t: 'e', code: 'empty_completion' });
      else out({ t: 'done', truncated: stop === 'max_tokens' });
      controller.close();
    },
    cancel() { ac.abort(); }
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' }
  });
}
