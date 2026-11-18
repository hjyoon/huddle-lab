# OpenClaw 음성 제공자

`npm run demo`의 `http://127.0.0.1:4184/`에서 **대화할 AI → OpenClaw**를 선택합니다.
OpenClaw에 설정된 모델·인증으로 대화하고, 음성 인식과 합성은 Mac에서 처리합니다.
선택한 모델 이름도 연결 상태 옆에 표시합니다.

로컬 경로는 `openclaw infer model run --local --json`을 사용하는 **도구 없는 모델 대화**입니다.
대화 기록은 Huddle이 관리합니다. OpenClaw의 기존 에이전트 세션·메모리·도구·메신저 채널을
연결하는 기능은 포함하지 않습니다. 로컬 모드는 `agent`, `message`, `--deliver` 경로를 호출하지 않습니다.
여기서 `--local`은 로컬 CLI 실행을 뜻하며, 인식된 텍스트는 설정된 모델 서비스로 전송됩니다.

## 원격 Gateway: 화면에서 설정

1. 통합 화면에서 **OpenClaw → 원격 Gateway**를 선택합니다.
2. **Gateway 주소**에 `wss://gateway.example`을 입력합니다. SSH 터널을 열어 둔 경우
   `ws://127.0.0.1:18789` 같은 loopback 주소도 사용할 수 있습니다.
3. **인증 방식**에서 토큰 또는 비밀번호를 선택하고 해당 정보를 입력합니다.
4. 특정 에이전트를 사용하려면 **에이전트 ID**를 입력합니다. 비워 두면 원격 Gateway의 기본 에이전트를 사용합니다.
5. **저장 · 연결 확인**을 누르고 준비 완료가 표시되면 통화를 시작합니다.

브라우저는 로컬 Huddle 서버에만 연결합니다. 로컬 서버가 설치된 OpenClaw CLI를 통해 원격 Gateway에 연결하므로
원격 모드에도 이 Mac의 OpenClaw CLI와 로컬 음성 엔진이 필요합니다. 토큰 외에 CLI 기기 페어링 승인이
필요한 Gateway라면 원격 서버에서 해당 기기를 승인해야 합니다. TLS와 기기 서명은 CLI가 처리합니다.
Huddle은 조회 연결에 이어 모델 요청을 보내지 않는 `agent.wait` 조회로 실행 권한(`operator.write`)을 확인합니다.
조회 기기를 승인한 뒤 실행 권한 추가 요청이 표시되면 운영 OpenClaw의 Devices에서 해당 요청을 검토하고 승인합니다.
승인 후 Huddle의 **연결 다시 확인**을 누르면 저장된 인증으로 연결 상태를 다시 확인합니다.
공개 원격 주소는 `wss://`만 허용하며 인증 정보를 URL에 포함하는 형식은 거절합니다.

인증 정보는 `.huddle-runtime/openclaw-remote.json`에 현재 사용자 전용 권한(`0600`)의 일반 파일로 저장합니다.
서버 재시작 시 주소·에이전트·인증을 함께 복원합니다. 입력란은 저장된 인증을 가려서 표시하고 같은 Huddle 화면에서
눈 아이콘을 누르면 원문을 보여줍니다. 일반 설정 조회에는 원문이 포함되지 않습니다. 원격 Gateway를 호출하는 CLI에는
환경변수로 인증을 전달합니다.
브라우저는 AI 선택·로컬/원격 모드·마지막으로 적용한 주소를 저장합니다. **저장된 인증 삭제**는 로컬 인증 파일과
현재 원격 연결 설정을 삭제합니다. 기기 승인은 운영 Gateway의 Devices에서 관리합니다. 통화 중 설정 변경과 삭제는 제한됩니다.

원격 모델 요청은 공식 `infer model run --gateway`와 같은 `agent` RPC의
`modelRun: true`, `promptMode: "none"` 모드를 사용합니다. 각 발화에 Huddle 전용 session/run ID를 만들고,
`agent.wait`의 완료된 답변을 읽습니다. 기존 에이전트 세션·도구·메모리·메신저 전달은 사용하지 않습니다.
모델은 원격 에이전트에 설정된 기본 모델을 사용합니다. 로컬용 `HUDDLE_OPENCLAW_MODEL`은 원격 모델을 변경하지 않습니다.
`agent.wait`의 `terminalReply`를 지원하는 Gateway가 필요하며, 2026.11.4에서 이 RPC 흐름을 검증했습니다.

끼어들면 로컬 오디오 재생을 즉시 중단하고, `chat.abort`에 **해당 Huddle의 정확한 session/run ID**를 전달한 뒤
`agent.wait`로 실행 종료를 확인합니다. 요청 접수 중에 끼어든 경우 접수 확인 후 해당 실행을 취소합니다.
취소 확인 전에는 다음 발화의 추론을 시작하지 않습니다. 서버 실행 종료나 접수 여부를 확인하지 못하면
통화를 닫고 새 요청을 차단합니다. 이때는 원격 Gateway의 실행 상태를 확인한 뒤 설정을 다시 적용합니다.

이 경로의 흐름은 `마이크 → 로컬 Whisper → 원격 Gateway의 모델 → 로컬 macOS 합성 → 스피커`입니다.
원격으로 전달되는 내용은 인식된 대화 텍스트입니다. 음성 합성은 모델 답변이 완성된 뒤 시작합니다.

연결 방식은 [공식 원격 접속 안내](https://docs.openclaw.ai/gateway/remote)와
[추론 CLI 안내](https://docs.openclaw.ai/cli/infer)를 참고합니다.

## 준비와 설정

```sh
npm ci
npm run setup:voice
openclaw models status
npm run demo
```

macOS, 사용할 모델과 인증이 설정된 OpenClaw CLI, 로컬 Whisper와 macOS 음성 `Yuna`가 필요합니다.
기존 `setup:claude`로 설치했다면 같은 음성 엔진·모델 파일을 재사용하므로 추가 다운로드가 필요 없습니다.
`setup:voice`도 동일한 `.huddle-runtime/claude` 경로를 사용하며 Claude 로그인은 요구하지 않습니다.
설치·Python·언어·음성 설정은 [로컬 음성 안내](claude-voice.md)를 참고합니다.

- `HUDDLE_OPENCLAW_BINARY`: OpenClaw 실행 파일. 기본은 `openclaw`.
- `HUDDLE_OPENCLAW_AGENT`: 모델과 인증을 사용할 OpenClaw agent ID. 생략하면 CLI의 기본 선택 규칙을 따릅니다.
- `HUDDLE_OPENCLAW_MODEL`: `provider/model` 형태의 모델 선택. 생략하면 OpenClaw에 설정된 모델을 사용합니다.
- `HUDDLE_CLAUDE_PYTHON`, `HUDDLE_CLAUDE_ASR_MODEL`, `HUDDLE_CLAUDE_LANGUAGE`, `HUDDLE_CLAUDE_VOICE`는
  두 제공자가 공유하는 로컬 음성 엔진에도 적용됩니다.

위 값은 서버 실행 환경에서 지정합니다. 브라우저가 프로세스 인자나 모델 설정을 임의로 보내는 경로는 없습니다.
준비 상태 확인은 `infer model auth status --json`에서 agent·모델 이름과 누락된 인증 여부만 사용하며
전체 인증 정보는 브라우저에 전달하지 않습니다. 모델 서비스 접근 성공 여부는 실제 요청에서 확인합니다.

설치된 CLI가 `--prompt-stdin`을 지원하면 대화 텍스트는 stdin으로 전달합니다.
검증한 2026.11.4 버전에는 해당 옵션이 없어 `--prompt` 인자를 사용합니다. 이 경우 로컬 프로세스
목록을 볼 수 있는 사용자에게 요청 텍스트가 보일 수 있습니다. Huddle은 요청 인자를 로그에 출력하지 않습니다.

## 재사용과 취소

```ts
import { createAgentHuddle } from "huddle-lab/agent-voice";
import { openWebAudio } from "huddle-lab/web-audio";
import { createOpenClawVoiceProvider } from "huddle-lab/openclaw-voice";

const huddle = createAgentHuddle({
  openAudio: openWebAudio,
  provider: createOpenClawVoiceProvider({ url: openClawVoiceHostUrl }),
});
await huddle.start();
```

`openClawVoiceHostUrl`은 통합 호스트의 `/api/providers/openclaw?mode=local` 또는 `?mode=remote`가 반환하는 loopback WebSocket URL입니다.
호스트를 별도로 구성할 때는 `scripts/openclaw-host.mjs`의 `createOpenClawHost()`를 사용합니다.
통합 화면과 같은 Origin만 추가로 신뢰하며 다른 Origin과 동시 클라이언트는 거절합니다.

Claude와 OpenClaw는 `src/local-voice/`, `scripts/local-voice-host.mjs`, `scripts/local-speech.mjs`의
발화 감지·PCM 전송·작업 수명·음성 엔진을 공유합니다. 기존 Claude 공개 진입점은 유지했습니다.
새 발화 시 예약된 재생을 비우고 이전 작업을 abort하며, 소유 CLI 프로세스가 종료된 뒤 다음 작업을 시작합니다.
원격 모드는 위의 Gateway 실행 취소·종료 확인도 함께 기다립니다.
이전 발화 번호의 늦은 오디오는 재생하지 않습니다. 끼어들기에 소켓 재연결은 필요하지 않습니다.

기록은 통화별로 메모리에 최대 20개 항목·24,000자까지 유지합니다. 입력은 최대 30초이며
발화 종료 뒤 Whisper → 모델 응답 완료 → 합성 → 재생 순으로 처리합니다. 도구 실행이나
토큰 단위 음성 스트리밍은 현재 범위에 포함하지 않습니다. 임시 WAV와 합성 파일은 작업 후 삭제합니다.

## 원격 모드 검증: 2026-11-18

- 단위/통합 115개와 Chrome 브라우저 20개 통과.
- 원격 주소·토큰·비밀번호 설정, 인증 정보 비저장, 외부 Origin 거절, 통화 중 설정 잠금,
  접수 중 취소, 원격 실행 종료 확인, 종료 확인 실패 시 새 요청 차단을 자동 검증했습니다.
- Chrome의 실제 AudioWorklet/VAD → 원격 백엔드 RPC 수명 → PCM 재생 경로에서 끼어들기를 검사했습니다.
  Gateway·음성 엔진은 테스트 대역이며, 첫 원격 실행의 종료 확인 뒤 다음 발화를 접수했습니다.
- 실제 로컬 OpenClaw 2026.11.4 Gateway에서 같은 원격 백엔드 RPC 흐름을 별도로 검증했습니다.
  CLI가 기존 로컬 연결 인증을 사용하도록 테스트 주입했고, 한국어 답변을 받았습니다.
  생성 중 취소는 `chat.abort`의 `aborted: true` 및 실행 ID 1개, 이후 `agent.wait`의 종료 상태를 확인했습니다.
  원격 주소·토큰 인증과 네트워크를 통과하는 실제 운영 서버 검증은 UI에서 해당 서버 인증을 입력한 뒤 수행해야 합니다.

## 기존 로컬 모드 검증: 2026-11-18

- 단위/통합 106개, Chrome 브라우저 18개 통과.
- OpenClaw 선택·저장·통화 중 선택 잠금·종료 후 전환·OpenClaw 전용 라우팅을 확인했습니다.
- 공유 음성 경로의 자동 barge-in, 늦은 PCM 차단, 취소·인증 오류 정리를 Claude와 OpenClaw 각각의 테스트 대역으로 검사했습니다.
- 실제 OpenClaw 2026.11.4(d843d6a), agent `main`, 모델 `openai/gpt-6.1-sol`로 한국어 응답을 받았습니다.
- 합성 한국어 마이크 → 브라우저 캡처 → 실제 로컬 Whisper → 실제 OpenClaw 모델 → macOS 합성 → 브라우저 재생도 확인했습니다.
  “안녕하세요. 짧게 인사해 주세요.”에 “안녕하세요! 만나서 반가워요.”로 응답했고 유음 PCM 102프레임을 재생했습니다.
  종료 후 대기 상태로 돌아왔으며 트랙·AudioContext를 모두 해제하고 브라우저 오류가 없음을 확인했습니다.
- 이 실서비스 검증은 합성 마이크를 사용했습니다. 물리 장치의 에코·잡음과 실제 OpenClaw 모델을 사용한
  겹침 발화의 중단 지연은 별도 검증 항목입니다.

설치된 CLI의 `--help`와 [공식 추론 CLI 문서](https://docs.openclaw.ai/cli/infer), 설치 패키지의
`model.run` 구현을 기준으로 연결했습니다. 임시 검증 로그·스크린샷·합성 입력 파일은 확인 후 정리했습니다.
