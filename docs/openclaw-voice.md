# OpenClaw 음성 제공자

`npm run demo`의 `http://127.0.0.1:4184/`에서 **대화할 AI → OpenClaw**를 선택합니다.
OpenClaw에 설정된 모델·인증으로 대화하고, 음성 인식과 합성은 Mac에서 처리합니다.
선택한 모델 이름도 연결 상태 옆에 표시합니다.

현재 경로는 `openclaw infer model run --local --json`을 사용하는 **도구 없는 모델 대화**입니다.
대화 기록은 Huddle이 관리합니다. OpenClaw의 기존 에이전트 세션·메모리·도구·메신저 채널을
연결하는 기능은 포함하지 않습니다. `agent`, `message`, `--deliver` 경로를 호출하지 않습니다.
여기서 `--local`은 로컬 CLI 실행을 뜻하며, 인식된 텍스트는 설정된 모델 서비스로 전송됩니다.

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

`openClawVoiceHostUrl`은 통합 호스트의 `/api/providers/openclaw`가 반환하는 loopback WebSocket URL입니다.
호스트를 별도로 구성할 때는 `scripts/openclaw-host.mjs`의 `createOpenClawHost()`를 사용합니다.
통합 화면과 같은 Origin만 추가로 신뢰하며 다른 Origin과 동시 클라이언트는 거절합니다.

Claude와 OpenClaw는 `src/local-voice/`, `scripts/local-voice-host.mjs`, `scripts/local-speech.mjs`의
발화 감지·PCM 전송·작업 수명·음성 엔진을 공유합니다. 기존 Claude 공개 진입점은 유지했습니다.
새 발화 시 예약된 재생을 비우고 이전 작업을 abort하며, 소유 CLI 프로세스가 종료된 뒤 다음 작업을 시작합니다.
이전 발화 번호의 늦은 오디오는 재생하지 않습니다. 끼어들기에 소켓 재연결은 필요하지 않습니다.

기록은 통화별로 메모리에 최대 20개 항목·24,000자까지 유지합니다. 입력은 최대 30초이며
발화 종료 뒤 Whisper → 모델 응답 완료 → 합성 → 재생 순으로 처리합니다. 도구 실행이나
토큰 단위 음성 스트리밍은 현재 범위에 포함하지 않습니다. 임시 WAV와 합성 파일은 작업 후 삭제합니다.

## 검증: 2026-11-18

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
