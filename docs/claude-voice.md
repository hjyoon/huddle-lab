# 로컬 Claude Code 음성 Huddle

Claude Code를 응답 엔진으로 사용하고, 로컬 Whisper와 운영체제별 로컬 음성 합성기를 연결합니다.
기존 `createAgentHuddle`의 UI·음소거·응답 재생·통화 수명을 재사용합니다.
현재 데모는 음성 대화용이며 Claude의 파일·셸·MCP 도구 실행은 켜지 않습니다.

## 실행

macOS 또는 Linux에서 Node.js 20.19 이상, Python 3.10–3.13(3.12 권장), Claude Code를 준비합니다.
macOS는 한국어 음성 `Yuna`와 `afconvert`, Linux는 eSpeak NG와 FFmpeg를 사용합니다.
[공유 음성 엔진 설치](../README.md#로컬-음성-엔진-설치)를 먼저 참고합니다.

```sh
npm ci
npm run setup:claude
claude auth status
npm run demo
```

`http://127.0.0.1:4184/`의 **대화할 AI**에서 Claude를 선택하고 **Claude와 통화 시작**을 누릅니다.
선택값은 브라우저에 저장하며, 통화 종료 후 Codex로 전환할 수 있습니다.
독립 화면은 `npm run demo:claude`로 `http://127.0.0.1:4183/`에서 실행합니다. 말을 마치고 약 0.7초 쉬면
인식된 텍스트가 Claude로 전달됩니다. 실제 모델 요청에서 로그인 오류가 나면
터미널에서 `claude auth login`을 실행합니다. CLI의 로그인 메타데이터가 true여도 실제
토큰이 사용 가능한지는 모델 요청 시 확인되므로 상태 표시만으로 인증 성공을 보장하지 않습니다.

`setup:claude`는 `.huddle-runtime/claude/venv` 안에 `faster-whisper==1.2.1`, `av==16.1.0`을
설치하고 다국어 Whisper `base` 모델을 프로젝트 캐시에 다운로드합니다. 모델은 약 153MB이며
Python 의존성도 같은 디렉터리에 설치합니다. Python의 기본 버전이 맞지 않으면 다음처럼
설치에 사용할 인터프리터를 지정합니다.

```sh
HUDDLE_PYTHON=/path/to/python3.12 npm run setup:claude
```

PyAV 19에서는 이 faster-whisper 버전이 사용하는 `metadata_errors` 인자가 제거되어
인식이 실패했으므로, 실제 음성 왕복을 확인한 PyAV 16.1.0을 고정했습니다.
모델·가상환경·임시 음성 파일은 Git이나 패키지에 포함하지 않습니다.

- `PORT=4193 npm run demo:claude`: 포트 변경.
- `HUDDLE_WORKSPACE=/absolute/project npm run demo:claude`: Claude 프로세스의 작업 폴더.
- `HUDDLE_CLAUDE_BINARY=/absolute/bin/claude`: Claude CLI 경로.
- `HUDDLE_CLAUDE_PYTHON=/absolute/python`: 설치한 faster-whisper 런타임 경로.
- `HUDDLE_CLAUDE_ASR_MODEL=small`: 로컬 인식 모델 변경. 같은 값으로 `setup:claude`를 먼저 실행합니다.
- `HUDDLE_CLAUDE_LANGUAGE=en` 또는 `auto`: 인식 언어 변경. 기본은 `ko`.
- `HUDDLE_CLAUDE_VOICE`: 합성 음성 변경. macOS 기본값은 `Yuna`이며 `say -v '?'`로 설치 음성을 확인합니다.
  Linux는 인식 언어의 음성을 기본으로 사용합니다. 인식 언어가 `auto`면 `ko`를 사용하며, `espeak-ng --voices`로 설치 음성을 확인합니다.

음성 인식·합성에는 외부 음성 API 키를 사용하지 않습니다. 인식된 대화 텍스트는 Claude Code의
기존 인증·모델 설정에 따라 Claude 서비스로 전송합니다. 발화 단위 임시 WAV와 합성 파일은
작업 종료·취소 후 삭제합니다. 강제 종료 시 남은 `.huddle-runtime/claude/job-*`는 수동 삭제할 수 있습니다.

음성 설치 명령 `npm run setup:voice`도 동일한 환경을 준비하며, OpenClaw와 음성 엔진을 공유합니다.

## 재사용

```ts
import { createAgentHuddle } from "huddle-lab/agent-voice";
import { openWebAudio } from "huddle-lab/web-audio";
import { createClaudeVoiceProvider } from "huddle-lab/claude-voice";

const huddle = createAgentHuddle({
  openAudio: openWebAudio,
  provider: createClaudeVoiceProvider({ url: "ws://127.0.0.1:4183/claude" }),
});
await huddle.start();
```

Node 호스트는 `scripts/claude-host.mjs`의 `createClaudeHost({ cwd, port, backend? })`입니다.
페이지 Origin을 확인하고 loopback에만 바인딩하며 한 클라이언트만 받습니다.
통합 실행에서는 선택 화면의 정확한 Origin을 추가로 신뢰합니다.
브라우저가 임의 모델 프롬프트·작업 폴더·프로세스 인자·도구 실행 RPC를 지정하는 경로는 없습니다.
`backend`는 `inspect()`, `transcribe(samples, signal)`, `reply(history, signal)`,
`synthesize(text, signal)`을 제공하는 주입 지점입니다. 다른 STT/TTS 엔진이나 테스트 대역을
연결할 때 브라우저와 통화 코어를 교체할 필요가 없습니다.

## 발화 감지와 취소

- 마이크 입력은 48 kHz 모노, 960 샘플(20ms)입니다. 브라우저 worklet과 장치의 echo cancellation을 사용합니다.
- 기본 RMS 0.012 이상의 3개 프레임(약 60ms)으로 발화 시작을 판단하고 최대 200ms의 앞부분을 함께 전달합니다.
- RMS 0.008 미만이 35개 프레임(약 700ms) 이어지면 발화를 마칩니다. 짧은 클릭성 입력은 인식 작업을 만들지 않습니다.
- 한 발화는 최대 30초입니다. 상한에 도달하면 처리한 뒤 조용해질 때까지 다음 발화를 열지 않습니다.
- 음소거처럼 입력 전달 자체가 멈추는 경우에도 타이머로 열린 발화를 마칩니다.

새 발화를 감지하면 클라이언트가 예약된 응답 재생을 즉시 비우고 새 발화 번호를 보냅니다.
호스트는 이전 인식·Claude 응답 생성·음성 합성에 abort를 전달합니다. 실행 중인 소유 프로세스 그룹에
SIGTERM을 보내고 필요하면 SIGKILL로 종료하며, 종료가 확인된 뒤 다음 작업을 시작합니다.
이전 번호의 늦은 텍스트·오디오는 전달하지 않고 클라이언트도 재생하지 않습니다.
수동 **응답 중단**도 같은 취소 경로를 사용합니다. barge-in에 WebSocket 재연결은 필요하지 않습니다.

Claude는 발화마다 새 `claude -p` 프로세스로 실행하며, 대화 기록은 호스트 메모리에 최대 20개 항목·24,000자까지
유지해 다음 요청에 전달합니다. Claude의 기존 대화를 resume하지 않습니다. 음성 전달까지 끝난
assistant 응답만 다음 대화 문맥에 넣으며 중단된 응답의 이미 들린 부분을 별도로 복원하지 않습니다.
`--no-session-persistence`, 빈 도구 목록, 빈 strict MCP 설정, 훅 비활성화를 사용합니다.

## 범위와 검증

발화 종료 → Whisper → Claude 텍스트 응답 완료 → 로컬 합성 → PCM 재생의 순차 경로입니다.
토큰 단위 음성 스트리밍은 구현하지 않았습니다. Claude 응답은 최대 1,200자, 합성 출력은 최대 60초로 제한합니다.
단순 에너지 감지는 잡음·스피커 에코에 강한 신경망 VAD가 아니므로 물리 장치에서 추가 확인이 필요합니다.

```sh
npm test
npm run test:browser
npm run verify:claude-speech
```

- 단위/통합 106개, Chrome 브라우저 18개 통과. Claude 테스트는 모델·STT/TTS 대역과 실제 브라우저 PCM 경로를 사용합니다.
- 제공자 선택·선택한 AI만 시작·통화 중 선택 잠금·종료 후 전환·선택 저장·늦은 상태 응답 차단을 확인했습니다.
- 자동 barge-in, 같은 소켓 유지, 늦은 이전 PCM 차단, 작업 취소·종료 대기, 음소거, 인증 오류 표시와 정리를 확인했습니다.
- 실제 로컬 Yuna 합성 → Whisper base 인식에서 한국어 문장이 원문과 일치했습니다.
- 실제 한국어 합성 입력 → 브라우저 캡처 → 로컬 Whisper → 모델 대역 → 로컬 TTS → 브라우저 재생도 확인했습니다.
- **실제 Claude 모델 응답은 미검증입니다.** CLI 2.1.140은 로그인 상태로 표시했으나 실제 요청에서
  `Not logged in · Please run /login`을 반환했습니다. 사용자가 로그인 갱신을 미루고 구현·자동 검증을 우선하도록 선택했습니다.

로컬 엔진 검증은 [한국어 음성 왕복 기록](verification/claude-local-speech-2026-11-17.json),
[브라우저 전체 경로 기록](verification/claude-local-pipeline-2026-11-17.json)에 남겼습니다.
`verify:claude-speech`는 실제 마이크와 Claude 모델을 사용하지 않고 합성 음성만 검사합니다.

실행 프로토콜은 [Claude Code CLI 문서](https://code.claude.com/docs/en/headless)와
[설치된 CLI의 `--help`](https://code.claude.com/docs/en/cli-reference)를,
로컬 STT는 [faster-whisper 공식 저장소](https://github.com/SYSTRAN/faster-whisper)를 기준으로 했습니다.
