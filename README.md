# AI Huddle Lab

Buzz 1.0.4에서 분리한 **사용자 ↔ AI 음성 대화 연결 코어**입니다.
마이크 입력을 AI 음성 제공자에 보내고 응답 음성을 재생하는 계약과 수명을 관리합니다.
기본 제공자는 원본처럼 **로컬 Codex 에이전트의 WebRTC 음성 기능**에 연결합니다.

## 실행

Node.js 20.19 이상, 음성 기능을 지원하는 Codex CLI와 로그인된 계정이 필요합니다.
저장소 루트에서 실행합니다.

```sh
codex login status
npm ci
npm run demo
```

`http://127.0.0.1:4182/`에서 **Codex와 통화 시작**을 눌러 마이크 권한을 허용합니다.
Codex의 기존 로그인으로 새 읽기 전용 대화를 열고 음성 응답과 발화문을 표시합니다.
음소거·끼어들기·종료 버튼을 사용할 수 있습니다. 음성은 Codex의 실시간 서비스로 전송됩니다.

[Codex 연결 안내](docs/codex-voice.md)에 작업 폴더·CLI 경로·포트 변경과 프로토콜, 검증 범위를 정리했습니다.
모델 없는 연결 테스트는 `npm run demo:agent`로 실행하며 기본 포트는 4181입니다.

## 실제 AI 제공자 연결 지점

```ts
import { createAgentHuddle } from "huddle-lab/agent-voice";
import { openWebAudio } from "huddle-lab/web-audio";

const huddle = createAgentHuddle({
  provider: yourVoiceProvider,
  openAudio: openWebAudio,
  signal: hostSessionAbort.signal,
});

await huddle.start();      // 명시적인 사용자 참여 동작
huddle.mute();            // 마이크 음소거 전환
await huddle.interrupt(); // AI 응답 취소 및 예약 재생 중단
await huddle.leave();
await huddle.dispose();
```

`yourVoiceProvider`가 구현할 계약은 다음과 같습니다.

- `open({ id, signal, emit })`: AI 음성 세션을 열고 연결 핸들을 반환합니다.
- `input(samples)`: 사용자 마이크의 48 kHz 모노 PCM을 받습니다.
- `emit(event)`: 응답 음성, 듣기/생각 상태, 응답 시작·종료와 최종 발화문을 전달합니다.
- `interrupt(responseId)`: 진행 중이거나 대기 중인 추론을 취소합니다.
- `close()`: 진행 중 작업과 미디어를 정리하고 완료될 때까지 기다립니다.

원본의 AI voice seat에서 이 수명 계약을 분리했습니다. 실제 모델 API, Codex 같은
에이전트 런타임, ASR/TTS, 음성 감지와 발화 차례는 제공자가 담당합니다.
직접 AI와 연결하는 이 경로에는 Nostr 계정·방 생성·사람 간 Relay가 필요하지 않습니다.

[AI 제공자 계약과 연결 예제](docs/agent-voice.md)에 이벤트 순서, 끼어들기,
취소·종료 범위를 정리했습니다.

## 모듈

| 모듈 | 역할 |
| --- | --- |
| `huddle-lab/codex-voice` | 로컬 Codex WebRTC 제공자와 브라우저 커넥터 |
| `huddle-lab/agent-voice` | 사용자와 AI의 직접 음성 세션, 상태·발화문·끼어들기 |
| `huddle-lab/web-audio` | 48 kHz 마이크 캡처, 음소거, 참가자별 재생 |
| `huddle-lab` | 재사용하는 통화 수명 컨트롤러와 PCM 전송 큐, 방 수명 해석 |
| `huddle-lab/relay` | 선택적인 Buzz Relay 인증·방 생성·WebSocket 어댑터 |
| `huddle-lab/webcodecs` | Relay 경로의 브라우저 Opus 인코딩·디코딩 |

패키지 루트와 AI 연결 모듈은 UI 프레임워크나 Tauri에 의존하지 않습니다.
Relay 모듈은 BIP-340 검증에 `@noble/curves`를 사용합니다.
어느 모듈도 import만으로 마이크나 외부 AI 연결을 시작하지 않습니다.

## 검증

```sh
npm test
npm run test:browser
npm run typecheck
```

브라우저 테스트는 기본적으로 설치된 Chrome과 가상 마이크를 사용합니다.
Chrome이 없다면 `npx playwright install chromium` 후
`HUDDLE_BROWSER_CHANNEL=chromium npm run test:browser`로 실행합니다.
자동 테스트의 Codex 프로토콜 fixture와 AI 테스트 제공자는 모델 추론을 하지 않습니다. 실제 모델의 음성 인식·답변 품질,
반응 시간, 도구 실행 및 물리 장치의 통화 품질을 검증한 것은 아닙니다.

## 진단용 예제

- `npm run demo:core`: 메모리 어댑터로 통화 상태와 PCM 큐를 확인하는 CLI.
- `npm run demo:audio`: 기본 마이크/스피커 확인 화면, 기본 포트 4173.
- `npm run demo:relay`: 임시 두 사용자로 Relay/Opus 통신을 확인하는 개발용 fixture, 기본 포트 4180.

Web Audio는 HTTPS 또는 localhost의 지원 브라우저에서 명시적인 사용자 동작으로 실행합니다.
기본 worklet은 `dist/web-audio/capture.worklet.js`와 함께 제공됩니다. 번들러가 해당 URL을
처리하지 못하면 `createWebAudioAdapter({ workletUrl: "/assets/capture.worklet.js" })`로
호스트가 제공하는 경로를 지정합니다. 장치 선택 UI와 Safari/WebKit 검증은 포함하지 않습니다.

사람 간 통화·방 기능은 진단용 모듈로 남아 있으며 AI 대화 경로의 필수 구성요소가 아닙니다.
[Relay 안내](docs/relay.md)에 인증·코덱·로컬 서버의 범위와 운영 서버 미검증 항목을 기록했습니다.

## 출처

원본은 `block/buzz-app`의 `v1.0.4`, 커밋
`a1c9c96940d2a6c81fce9beed9b7cbcc34b144b8`입니다.
통화·오디오 코드와 `features/huddle/voice.ts`의 AI 음성 좌석 수명을 분리했습니다.
Relay의 v2 형식은 원본이 고정한 `block/buzz` 커밋
`630922a9e1f891380a61f5b7d726d05ca948cc64`를 기준으로 합니다.

라이선스와 수정 내역은 [LICENSE](LICENSE), [NOTICE](NOTICE)를 확인하세요.
로컬 개발용 `private: true` 패키지이며 배포하지 않았습니다.
