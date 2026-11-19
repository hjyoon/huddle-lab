# 로컬 Codex AI Huddle

`npm run demo:codex`는 설치된 `codex app-server --stdio`를 실행하고 브라우저의
WebRTC 음성 경로를 연결합니다. Buzz 1.0.4의 `bundled/codex/voice.ts`, `rpc.ts`에서
미디어·프로토콜 수명을 분리했습니다. 모델 서버나 API 키 입력 화면은 따로 만들지 않습니다.

## 실행

```sh
codex login status
npm ci
npm run demo:codex
```

통합 화면은 `npm run demo`의 `http://127.0.0.1:4184/`에서 Codex를 선택합니다.
독립 화면은 `http://127.0.0.1:4182/`에서 **Codex와 통화 시작**을 누르고 마이크 권한을 허용합니다.
설치된 Codex에 로그인되어 있어야 하며 해당 계정·CLI가 실험적인 realtime v3 음성을
지원해야 합니다. 로그인이 필요하면 터미널에서 `codex login` 후 데모 서버를 재시작합니다.
로그인 확인은 음성 기능 이용 권한까지 보장하지 않습니다. 서비스의 오류는 화면에 표시합니다.

- `PORT=4190 npm run demo:codex`: HTTP 포트 변경.
- `HUDDLE_WORKSPACE=/absolute/project npm run demo:codex`: 대화에서 참고할 작업 폴더.
- `HUDDLE_CODEX_BINARY=/absolute/bin/codex npm run demo:codex`: CLI 경로 선택.
- `HUDDLE_CODEX_MODEL=gpt-5.6-sol npm run demo`: 이 Huddle에서 위임 작업을 처리할 Codex 모델 지정.
- `HUDDLE_CODEX_VOICE_MODEL=gpt-live-1.1-codex npm run demo:codex`: ChatGPT 로그인으로 사용할 실시간 음성 모델 지정.
- `npm run demo:agent`: 외부 모델을 사용하지 않는 기존 연결 구조 테스트.

Codex는 기존 설정·로그인·상태 경로를 사용합니다. 프로젝트의 `.huddle-runtime/`는
임시 app-server 로그를 보관하고 정상 종료 시 정리합니다. 강제 종료 후 남은 파일은 수동 삭제할 수 있습니다.
SQLite 경로를 임의로 바꾸면 기존 세션의 backfill 때문에 초기화가 지연될 수 있으므로 바꾸지 않습니다.
여러 CLI가 설치된 경우 서버 실행 환경의 PATH가 선택하는 바이너리를 사용하고 화면에 버전을 표시합니다.

## OpenClaw 업무 위임

통합 화면에서 **OpenClaw → Gateway (MCP)** 연결을 저장한 다음
`HUDDLE_CODEX_OPENCLAW_MAIN=1 npm run demo`로 실행하고 **Codex**를 선택합니다.
Codex 음성은 호스트의 ChatGPT 로그인으로 연결합니다. 기본 음성 모델은
`gpt-live-1.1-codex`이며, 준비 상태에 음성 모델과 위임 대상 `main`이 표시됩니다.
업무 요청을 전달할 Codex 텍스트 모델은 현재 로그인 계정의 기본 모델을 사용합니다.
`HUDDLE_CODEX_MODEL`이 지정되어 있으면 해당 모델을 선택합니다.

도구가 필요한 업무 요청은 첫 위임 시 생성한 해당 통화의 `main` 세션에서 실행합니다.
Gateway가 도구 접근과 승인을 처리하고, Codex는 완료 답변을 같은 통화에서 읽습니다.
새 Worker 기동을 포함해 업무 응답을 최대 120초 동안 기다립니다.
명시적인 중단은 해당 통화의 실행을 취소하고, 통화 종료는 Gateway에 Worker 회수를 요청합니다.
브라우저는 음성 모델이나 위임 대상을 지정할 수 없습니다.

## 재사용

```ts
import { createAgentHuddle } from "huddle-lab/agent-voice";
import { openWebAudio } from "huddle-lab/web-audio";
import { createCodexVoiceProvider, createCodexLocalConnector } from "huddle-lab/codex-voice";

const huddle = createAgentHuddle({
  openAudio: openWebAudio,
  provider: createCodexVoiceProvider({
    connect: createCodexLocalConnector("ws://127.0.0.1:4182/codex"),
  }),
});
await huddle.start();
```

Node 호스트는 `scripts/codex-host.mjs`의 `createCodexHost({ cwd, port })`로 실행합니다.
독립 실행에서는 이 호스트의 페이지 Origin을 확인합니다. 통합 실행에서는 선택 화면의 정확한
loopback Origin을 `allowedOrigins`로 추가해 신뢰하고, 다른 Origin은 거절합니다.
브라우저 번들에는 Node 프로세스 코드나 인증 정보가 포함되지 않습니다. worklet을 별도
서빙하는 번들러는 `createCodexVoiceProvider({ connect, workletUrl })`를 지정합니다.

## 흐름과 수명

1. 로컬 호스트가 JSONL `initialize` / `initialized`로 app-server를 연결합니다.
2. `account/read`로 로그인 여부를 확인하고 새 임시 대화를 만듭니다. 기존 대화에는 붙지 않습니다.
3. 브라우저가 사용자 PCM을 Web Audio → WebRTC 트랙으로 전송하고 SDP offer를 호스트에 보냅니다.
4. 호스트가 `thread/realtime/start`를 v3/audio/WebRTC로 호출합니다. Codex가 반환한 SDP answer로 연결합니다.
5. 원격 오디오를 48 kHz 모노 960 샘플로 캡처해 공통 AI Huddle 재생기에 전달합니다.
6. canonical realtime item의 완료된 발화문을 표시합니다. 구형 알림에는 legacy fallback을 사용하며,
   CLI가 발화문으로 변환하지 못하는 Live delta는 화자 변경·2초 무음을 기준으로 화면용 구간으로 묶습니다.
   이 구간은 서버가 확정한 발화 차례를 의미하지 않습니다.
7. v3 수동 끼어들기는 예약 재생을 지우고 활성 Codex turn을 중단한 뒤 realtime을 멈추고
   **같은 Codex 대화**에서 새 WebRTC 채널을 엽니다. 음성 재연결 중 입력은 보내지 않습니다.
   Codex thread는 재사용하지만 음성 모델의 세션 내부 상태와 미확정 발화는 별도로 복원하지 않습니다.
   v3에는 기존 Realtime의 `response.cancel`이 없으므로 지원되지 않는 명령을 보내지 않습니다.
   기존 Realtime 이벤트를 사용하는 호스트에는 `response.cancel` / `output_audio_buffer.clear`를 사용합니다.
   자연스러운 발화 겹침은 Codex의 VAD가 처리하고 사용자 발화문 이벤트에서 예약 재생을 중단합니다.
8. 종료 시 트랙·peer·AudioContext를 닫고 늦은 시작 응답을 기다린 뒤 realtime을 멈춥니다.
   소유 대화를 unsubscribe하고 해당 app-server 프로세스 그룹만 종료합니다.

worklet 메시지는 응답 세대 번호로 구분해 이미 큐에 들어간 이전 출력이 재생되지 않도록 합니다.
RTP 오디오 자체에는 응답 ID가 없으므로 네트워크에서 늦게 도착한 미디어를 완벽히 식별하는 계약은 아닙니다.
v3는 연속 오디오이며 응답 시작/종료 이벤트를 전제로 재생하지 않습니다. 오디오 에너지를 기준으로
말하기 표시와 로컬 응답 ID를 투영하며, 서버 발화 경계로 간주하지 않습니다. 기존 이벤트 경로의
`response.done`은 오디오 재생 완료와 다르므로 출력 버퍼 종료까지 오디오를 유지합니다.
Chrome의 원격 RTP 재생 시계를 시작하는 muted Audio 요소도 함께 소유·정리합니다.

호스트는 loopback에만 바인딩하고 Host/Origin을 확인하며 한 번에 한 클라이언트만 받습니다.
브라우저는 자기 대화의 음성 시작·종료·끼어들기만 요청할 수 있습니다. 임의 Codex RPC, 작업 폴더,
모델 설정, 토큰은 브라우저에서 전달할 수 없습니다. 대화는 `read-only`와 `on-request`로 만들고,
이 호스트는 대화형 도구·권한 승인 요청을 거절합니다. 도구 호출의 추가 권한 승인은 구현하지 않았습니다.

음성은 Codex의 실시간 서비스로 전송되며 로컬 전용 처리는 아닙니다. 앱은 별도 녹음 파일을 만들지 않습니다.
모델 선택·인증 갱신·코드 질문의 에이전트 위임은 설치된 Codex가 담당합니다.
Buzz 1.0.5와 같이 위임된 작업의 결과는 같은 통화에서 읽을 수 있도록 위임 턴의 최종 답변에 담습니다.
일반 질문에는 바로 답하고, 현재 상태를 확인할 수 없는 경우에는 통화에서 확인 범위와 확인 방법을 안내하도록 지시합니다.
v3 세션에서는 위임 시작 멘트를 끄고 음성 모델과 위임을 처리하는 Codex 양쪽에 답변 지침을 전달합니다.

## 검증 범위

`npm test`는 호스트의 Origin/소유 대화/RPC 제한/정리와 JSONL을 검증합니다.
`npm run test:browser`는 실제 Chrome RTCPeerConnection 두 개와 합성 오디오로 송수신·발화문·끼어들기·정리를 검증합니다.
이 자동 테스트는 모델 추론을 수행하지 않습니다. 로컬 실행 환경에서는 Codex CLI 0.150.1과 기존
ChatGPT 로그인으로 읽기 전용 대화·WebRTC 연결·합성 인사 입력 후 AI 음성 수신·발화문 표시·수동 끼어들기 재연결·종료 후 대기 복귀를 별도 확인했습니다.
자동 barge-in은 합성 발화로 실제 서비스에서 2회, 끼어들지 않는 대조 실험 1회로 확인했습니다.
[검증 결과와 재현 방법](barge-in-verification.md)에 이벤트 시각·연결 유지·측정 한계를 기록했습니다.

계정별 음성 권한, 실제 인식·답변 품질,
물리 마이크/스피커 품질은 별도로 확인해야 합니다.

프로토콜은 설치된 CLI의 `app-server generate-json-schema --experimental` 결과와
[공식 app-server 문서](https://learn.chatgpt.com/docs/app-server)를 기준으로 합니다.
실험적인 API이므로 CLI 변경에 따른 호환성 검증이 필요합니다.
