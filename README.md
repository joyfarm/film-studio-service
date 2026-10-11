# 영화대본 스튜디오 — 설치 안내서

혼자 쓰는 웹 서비스입니다. 로그인한 사람만 쓸 수 있고, 데이터와 컷 이미지는 Supabase에, 대본 생성은 Claude API로 처리합니다.

## 파일 구성

| 파일 | 역할 |
|---|---|
| `index.html` | 화면 전체(로그인, 대본, 사람과 역할, 스토리보드, 엔딩 크레딧) |
| `config.js` | Supabase 주소와 공개 키를 넣는 곳 (직접 수정) |
| `api/generate.js` | 대본 만들기 서버 함수. 로그인 확인 후 Claude 호출 |
| `api/_rules.js` | `/edu-video-script` 규칙. 대본 형식을 바꾸려면 이 파일만 고치면 됩니다 |
| `supabase/schema.sql` | 데이터 테이블, 이미지 저장소, 보안 규칙 |
| `vercel.json`, `.vercelignore` | 배포 설정 |

## 설치 순서

### 1. Supabase 프로젝트 만들기
1. supabase.com 에 가입하고 **New project** 를 만듭니다. 지역은 가까운 곳(예: Seoul)을 고릅니다.
2. 왼쪽 **SQL Editor** → 새 쿼리에 `supabase/schema.sql` 내용을 전부 붙여 넣고 **Run** 합니다. 여러 번 실행해도 안전합니다.
   - `docs` 테이블과 비공개 이미지 저장소 `cuts` 가 만들어지고, "내 계정 데이터만 읽고 쓴다"는 규칙이 걸립니다.

### 2. 가입 막고 내 계정만 만들기
1. **Authentication** 설정에서 **Allow new users to sign up** 을 **끕니다.** (메뉴 이름과 위치는 대시보드 버전에 따라 조금 다를 수 있습니다.) 이렇게 하면 남이 가입할 수 없습니다.
2. **Authentication → Users → Add user → Create new user** 에서 내 이메일과 **비밀번호를 직접 입력**하고, **Auto Confirm User** 를 체크합니다.
3. 이 이메일·비밀번호가 앱 로그인 정보입니다. 비밀번호는 나중에 같은 화면에서 바꿀 수 있습니다.

### 3. 화면에 Supabase 연결하기
1. **Project Settings → API** 에서 `Project URL` 과 `anon public` 키를 복사합니다.
2. `config.js` 의 `SUPABASE_URL`, `SUPABASE_ANON_KEY` 에 붙여 넣습니다.
   - 이 두 값은 공개되어도 안전하도록 설계된 값입니다. 데이터 보호는 2번의 계정 설정과 1번의 보안 규칙이 담당합니다.
   - **`service_role` 키와 Claude API 키는 여기에 절대 넣지 마세요.**

### 4. Claude API 키 받기
console.anthropic.com 에서 API 키를 만듭니다. 대본 생성 때마다 사용량만큼 요금이 나옵니다(Claude 앱 구독과는 별개입니다). 콘솔에서 월 사용 한도를 걸어 두는 것을 권합니다.

### 5. Vercel에 올리기
1. 이 폴더를 GitHub 저장소에 올립니다. (`config.js` 는 공개 키만 있으므로 올려도 됩니다.)
2. vercel.com 에서 **Add New → Project** 로 그 저장소를 가져옵니다. Framework Preset 은 **Other** 입니다.
3. **Environment Variables** 에 아래를 넣고 Deploy 합니다.

| 이름 | 값 |
|---|---|
| `ANTHROPIC_API_KEY` | 4번에서 만든 키 |
| `SUPABASE_URL` | 3번의 Project URL |
| `SUPABASE_ANON_KEY` | 3번의 anon 키 |
| `ALLOWED_EMAILS` | 내 로그인 이메일 (권장. 쉼표로 여러 개 가능) |
| `CLAUDE_MODEL` | (선택) 기본값은 `claude-sonnet-5-5` |

환경 변수를 나중에 바꾸면 **Redeploy** 해야 반영됩니다.

### 6. 확인하기
1. 배포 주소를 열면 로그인 화면이 나옵니다. 2번의 이메일과 비밀번호로 로그인합니다.
2. 제목을 고치면 상단 상태가 "저장됨"으로 바뀌는지 봅니다. 새로고침해도 남아 있으면 정상입니다.
3. 스토리보드 탭에서 컷에 이미지를 올립니다. 올릴 때 가로 1280px 이하 JPG로 자동으로 줄여 저장합니다.
4. 대본 만들기 탭에서 이야기를 적고 생성이 되는지 봅니다.

## 알아 둘 점

- **무료 플랜 일시 중지:** Supabase 무료 프로젝트는 1주일 동안 접속이 없으면 일시 중지됩니다. 대시보드에서 다시 켤 수 있습니다. 자주 쓰지 않는다면 주 1회 로그인하거나 유료 플랜을 고려하세요.
- **용량:** 무료 플랜은 파일 저장소 1GB, DB 500MB입니다. 컷 이미지는 줄여서 올라가므로 한 장에 보통 수백 KB 이하입니다. 사용량은 Supabase 대시보드(Storage, Database)에서 볼 수 있습니다.
- **백업:** 중요한 작업은 `전체 .md 내보내기` 로 받아 두세요. 이미지는 .md에 들어가지 않습니다.
- **현재 구조:** 한 계정에 영화 프로젝트 하나를 저장합니다. 여러 프로젝트를 나눠 쓰는 기능은 아직 없습니다.
- **비용 보호:** `/api/generate` 는 로그인한 사용자만 호출할 수 있고, `ALLOWED_EMAILS` 로 한 번 더 제한합니다. 호출 횟수 제한은 아직 없으니 Claude 콘솔의 사용 한도를 설정해 두세요.
- **글꼴:** Pretendard(jsDelivr)와 Nanum Gothic Coding(Google Fonts)을 인터넷에서 불러옵니다. 불러오지 못하면 시스템 글꼴로 대신 표시됩니다.
