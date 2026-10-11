/* 대본 생성 API (방법 A): 로그인 확인 → 서버에 둔 스킬 규칙 + 요청을 Claude API에 보내고 결과를 한 줄씩(NDJSON) 흘려 보낸다.
   환경 변수: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, (선택) ALLOWED_EMAILS, CLAUDE_MODEL */
const { RULES } = require('./_rules.js');

const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const MAX_TOKENS = 8000;
const MAX_IDEA = 4000;

const fail = (res, status, code) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ code }));
};
const oneLine = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

function buildPrompt(idea, len, aud) {
  const hints = [];
  if (len) hints.push('길이: ' + len);
  if (aud) hints.push('대상: ' + aud);
  return '[요청]\n' + idea + (hints.length ? '\n\n[추가 조건]\n' + hints.join('\n') : '') +
    '\n\n위 요청으로 대본을 출력 형식 그대로 작성하세요.';
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');

  const { SUPABASE_URL, SUPABASE_ANON_KEY, ANTHROPIC_API_KEY, ALLOWED_EMAILS } = process.env;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !ANTHROPIC_API_KEY) return fail(res, 500, 'server_misconfigured');

  // 1) 로그인한 사용자인지 확인 (Supabase가 토큰을 검증한다)
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return fail(res, 401, 'session_expired');
  let user;
  try {
    const ur = await fetch(SUPABASE_URL.replace(/\/$/, '') + '/auth/v1/user', {
      headers: { Authorization: 'Bearer ' + m[1], apikey: SUPABASE_ANON_KEY }
    });
    if (!ur.ok) return fail(res, 401, 'session_expired');
    user = await ur.json();
  } catch (e) { return fail(res, 502, 'upstream_error'); }
  if (!user || !user.id) return fail(res, 401, 'session_expired');
  if (ALLOWED_EMAILS) {
    const ok = ALLOWED_EMAILS.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (!ok.includes(String(user.email || '').toLowerCase())) return fail(res, 403, 'forbidden');
  }

  // 2) 입력 검사
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  body = body && typeof body === 'object' ? body : {};
  const idea = String(body.idea == null ? '' : body.idea).trim();
  if (!idea) return fail(res, 400, 'empty_request');
  if (idea.length > MAX_IDEA) return fail(res, 413, 'prompt_too_large');
  const prompt = buildPrompt(idea, oneLine(body.len, 60), oneLine(body.aud, 60));

  // 3) Claude 호출
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  let ar;
  try {
    ar = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ac.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, stream: true, system: RULES, messages: [{ role: 'user', content: prompt }] })
    });
  } catch (e) { return fail(res, 502, 'upstream_error'); }
  if (!ar.ok) {
    const code = ar.status === 429 || ar.status === 529 ? 'rate_limited' : ar.status === 413 ? 'prompt_too_large'
      : ar.status === 401 || ar.status === 403 ? 'server_misconfigured' : 'upstream_error';
    return fail(res, 502, code);
  }

  // 4) 결과를 한 줄씩 흘려 보낸다: {"t":"d","x":"글자"} … {"t":"done","truncated":false}
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');
  const out = o => res.write(JSON.stringify(o) + '\n');
  const dec = new TextDecoder();
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
    for await (const chunk of ar.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i).trim()); buf = buf.slice(i + 1); }
    }
    if (buf.trim()) handle(buf.trim());
  } catch (e) {
    if (!ac.signal.aborted) out({ t: 'e', code: 'upstream_error' });
    return res.end();
  }
  if (failed) out({ t: 'e', code: failed });
  else if (stop === 'refusal') out({ t: 'e', code: 'refused' });
  else if (!total) out({ t: 'e', code: 'empty_completion' });
  else out({ t: 'done', truncated: stop === 'max_tokens' });
  res.end();
};

