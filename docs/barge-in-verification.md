# 실제 Codex 자동 barge-in 검증

2026-11-17, 설치된 Codex CLI 0.150.1과 기존 ChatGPT 로그인으로 실제 음성 서비스에
접속해 자동 barge-in을 두 번 관찰했습니다. 끼어들기 버튼이나 수동 interrupt RPC를
호출하지 않았으며, WebRTC 연결 하나를 유지한 채 기존 숫자 세기를 끝내고 새 요청에 응답했습니다.
애플리케이션의 런타임 코드는 변경하지 않았습니다.

## 방법

1. 합성 음성으로 “Please count slowly from one to fifty, without stopping. Do not use any tools.”를 보냅니다.
2. 앱 스피커 출력에서 누적 900ms 이상의 유음 프레임을 확인하고, AI가 말하는 동안
   “Wait. Stop counting. Say only banana.”를 주입합니다.
3. 마이크 PCM, 원격 RTP에서 추출한 PCM, 앱 재생 GainNode 출력에 각각 타임스탬프와 RMS를 기록합니다.
4. data channel의 발화문과 `turn.done`, 제공자 이벤트, 브라우저 RPC 요청을 기록합니다.
5. 같은 요청을 보내고 끼어들지 않는 대조 실험을 수행합니다.

실제 `getUserMedia` 호출 대신 Web Audio로 만든 가상 마이크 스트림을 주입했습니다.
이후 앱의 캡처 worklet → Huddle 코어 → WebRTC → Codex 서비스 → 앱 재생 경로는 실제 코드입니다.
물리 마이크는 수집하지 않았고 Chrome의 최종 장치 출력을 mute했습니다. 재생 계측은 mute 이전의
렌더링 그래프에서 수행했습니다. 미디어는 48 kHz 모노, 계측 프레임은 20ms입니다.

## 결과

| 관찰 | 1회차 | 2회차 |
| --- | ---: | ---: |
| 이전 AI 발화와 사용자 발화의 유음 겹침(근사치) | 680ms | 380ms |
| 사용자 발화문 첫 이벤트 수신 | 1,390ms | 1,280ms |
| 기존 AI `turn.done` 수신 | 1,433ms | 1,326ms |
| 기존 AI 발화문 | One... two... three | One... two... three... |
| 끼어든 뒤 새 응답 | Okay. Banana. | Okay. Banana. |
| WebRTC 연결 / realtime 시작 횟수 | 1 / 1 | 1 / 1 |
| 수동 `voice/interrupt` 요청 | 0 | 0 |
| 종료 후 대기 상태·미디어 정리 | 성공 | 성공 |

시간은 끼어드는 마이크 PCM의 첫 유음 프레임을 기준으로 합니다. RMS 0.003 초과를
유음으로 분류했고, 겹침은 두 스트림의 프레임 도착 시각을 ±25ms로 대응시킨 근사치입니다.
`turn.done` 수신은 기존 서버 턴이 끝났음을 확인한 시각이며 **정확한 음향 중단 지연은 아닙니다.**
숫자 사이의 자연스러운 쉼 때문에 첫 500ms 무음 구간도 barge-in 지연으로 해석하지 않았습니다.
제공자 `response-interrupted` 이벤트 역시 발화문 도착·당시 로컬 재생 상태에 좌우되므로
서버 중단 시각을 나타내는 지표로 사용하지 않았습니다.

대조 실험에서는 같은 요청에 끼어들지 않자 `One...`에서 `fourteen...`까지 계속 셌습니다.
AI 재생이 유지되는 동안 테스트를 끝냈습니다. 따라서 두 실험에서 3까지 세고 새 요청으로
전환된 것을 답변의 예정된 자연 종료로 보지 않았습니다.

- [두 번의 실행 요약 JSON](verification/codex-barge-in-2026-11-17.json)
- [대조 실험 요약 JSON](verification/codex-barge-in-control-2026-11-17.json)
- 로컬 원본: `/Users/ghost/codex-sandbox/tmp/huddle-barge-in-20261117/`의 `trial-1.json`, `trial-2.json`, `control-1.json`.

브라우저 오류와 연결 오류는 없었으며, 세 실험 모두 종료 시 마이크 트랙·peer·AudioContext를
해제하고 `idle`로 복귀했습니다. 위 결과는 이 계정·CLI·합성 발화에서의 관찰입니다.
물리 스피커 에코, 실제 마이크 DSP, 잡음, 한국어 발화 및 다양한 말하기 속도는 검증하지 않았습니다.

## 재현

저장소 루트에서 `npm ci`와 `npm run build`를 실행한 뒤 짧은 `prompt.wav`, `interrupt.wav`를
같은 디렉터리에 준비합니다. macOS에서는 아래처럼 합성할 수 있습니다.

```sh
mkdir -p .huddle-runtime/barge-in
say -v Samantha -r 165 -o .huddle-runtime/barge-in/prompt.aiff 'Please count slowly from one to fifty, without stopping. Do not use any tools.'
say -v Samantha -r 185 -o .huddle-runtime/barge-in/interrupt.aiff 'Wait. Stop counting. Say only banana.'
afconvert .huddle-runtime/barge-in/prompt.aiff .huddle-runtime/barge-in/prompt.wav -f WAVE -d LEI16@48000 -c 1
afconvert .huddle-runtime/barge-in/interrupt.aiff .huddle-runtime/barge-in/interrupt.wav -f WAVE -d LEI16@48000 -c 1
node scripts/verify-codex-barge-in.mjs .huddle-runtime/barge-in 2
node scripts/verify-codex-barge-in.mjs .huddle-runtime/barge-in 1 control
```

이 스크립트는 설치된 Chrome과 Codex 로그인을 사용해 실제 서비스에 접속합니다.
`npm test`와 분리된 명시적 실행 도구입니다. 결과·프레임 기록을 입력 WAV 디렉터리에 저장합니다.
이전 실행 파일을 보존하려면 매번 새 디렉터리를 사용합니다. `summary.json`의
`automaticBargeInObserved`는 유음 겹침·발화 인식·기존 AI 턴 종료·Banana 응답·단일 연결·수동 요청 없음으로
판정합니다. 이 조건을 충족하지 못하면 barge-in 모드의 종료 코드는 1입니다.
