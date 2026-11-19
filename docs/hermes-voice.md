# Hermes 음성 제공자

`npm run demo`의 `http://127.0.0.1:4184/`에서 **대화할 AI → Hermes**를 선택합니다.
[Hermes Agent](https://github.com/NousResearch/hermes-agent)의 API 서버에 연결해, Hermes가 가진 모델·메모리·도구로 대화합니다.
음성 인식과 합성은 Claude/OpenClaw와 같은 로컬 엔진(Whisper, macOS `say`)을 사용하고, Hermes로는 인식된 텍스트만 전송합니다.

흐름: `마이크 → 로컬 Whisper → Hermes API 서버(/v1/runs) → 로컬 macOS 합성 → 스피커`

## Hermes 쪽 준비

Hermes 호스트의 `~/.hermes/.env`에 API 서버를 켭니다.

```sh
API_SERVER_ENABLED=true
API_SERVER_KEY=<충분히 긴 임의 문자열>
```

게이트웨이를 재시작하면 `http://127.0.0.1:8642`에서 대기합니다. 자세한 내용은
[Hermes API Server 문서](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server)를 참고합니다.

API 서버는 공개 인터넷에 열지 않는 것을 권장합니다. Mac에서 SSH 터널로 연결합니다.

```sh
ssh -N -L 8642:127.0.0.1:8642 <hermes-host>
```

## Huddle 쪽 설정

```sh
npm ci
npm run setup:voice
HUDDLE_HERMES_URL=http://127.0.0.1:8642 HUDDLE_HERMES_KEY=<API_SERVER_KEY> npm run demo
```

- `HUDDLE_HERMES_URL`: Hermes API 서버 주소. `https://` 또는 loopback(`http://127.0.0.1`, `http://localhost`)만 허용하며,
  주소에 인증 정보·쿼리를 넣으면 거절합니다. 끝의 `/v1`은 생략해도 됩니다.
- `HUDDLE_HERMES_KEY`: Hermes의 `API_SERVER_KEY`. 브라우저로 전달하지 않으며 상태 응답과 오류 메시지에도 포함하지 않습니다.
- 음성 엔진 설정(`HUDDLE_CLAUDE_PYTHON`, `HUDDLE_CLAUDE_ASR_MODEL`, `HUDDLE_CLAUDE_LANGUAGE`, `HUDDLE_CLAUDE_VOICE`)은 다른 로컬 음성 제공자와 공유합니다.

준비 상태는 `GET /v1/capabilities`로 확인합니다. Runs API의 제출·상태 조회·중단(`run_submission`, `run_status`, `run_stop`)을
지원하지 않는 Hermes 버전이면 연결하지 않습니다.

## 통화와 발화

- 통화 하나가 Hermes 세션 하나(`session_id: huddle-<uuid>`)입니다. 발화마다 같은 세션에 `POST /v1/runs`로 실행을 하나 만들고,
  Hermes가 세션 기록(도구 호출·결과 포함)을 이어서 관리합니다. Huddle은 현재 발화만 보냅니다.
- 실행마다 음성용 지침(짧은 구어체, Markdown·URL 금지, 이번 턴 안에 끝내기, 백그라운드 작업 금지)을 `instructions`로 붙입니다.
  답변에 남은 Markdown은 읽기 전에 제거하고 1,200자 안으로 자릅니다.
- `GET /v1/runs/{id}`를 폴링해 `completed`이면 `output`을 읽습니다. `failed`·`cancelled`·`interrupted`는 오류로 알립니다.
- Hermes가 위험한 명령의 **승인 대기**(`waiting_for_approval`)로 들어가면 통화에서는 승인할 수 없으므로 실행을 중단하고 안내합니다.
- 기본 응답 대기 시간은 120초입니다. 도구를 쓰는 답변은 몇 초에서 수십 초가 걸릴 수 있습니다.

## 끼어들기와 실패 처리

- 실행 제출은 끼어들기와 분리되어 있어, 제출 중에 말해도 실행 ID를 받은 뒤 그 실행만 `POST /v1/runs/{id}/stop`으로 중단합니다.
- 중단 요청 뒤 해당 실행이 종료 상태가 될 때까지 기다린 다음 다음 발화를 처리합니다.
- 제출 응답이 네트워크 오류로 사라지면 같은 `Idempotency-Key`로 한 번만 다시 보내 같은 실행을 찾습니다. 새 실행을 만들지 않습니다.
- 실행 접수 여부나 종료를 확인하지 못하면 통화를 닫고 이후 요청을 막습니다. Hermes에서 실행 상태를 확인한 뒤 Huddle을 다시 시작합니다.
- HTTP 오류(401/403/404/429/503 등)는 Huddle이 정한 문장으로만 알리고 서버 응답 본문은 표시하지 않습니다.

## 검증 범위

- `tests/hermes-backend.test.mjs`: 가짜 Runs API로 설정 검증, 준비 상태, 세션·실행 단위, 끼어들기 중단과 종료 확인,
  제출 중 끼어들기, 중단 미확인 시 차단, 멱등 재전송, 승인 대기 중단, 오류 문장 정리, Markdown 제거를 검사합니다.
- `tests/ai-host.test.mjs`: 선택 화면 목록과 Hermes 전용 음성 경로 라우팅을 검사합니다.
- 실제 Hermes API 서버와 Mac 음성 엔진을 연결한 통화, 브라우저(Playwright) 테스트는 아직 수행하지 않았습니다.
