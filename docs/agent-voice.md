# AI Huddle 제공자 계약

이 프로젝트의 목적은 사용자와 AI의 음성 Huddle입니다. 코어는 특정 모델에 의존하지 않고
AI 음성 제공자 인터페이스, 오디오 경로와 수명 관리를 제공합니다. 기본 데모는
[로컬 Codex 제공자](codex-voice.md)를 연결하며, 이 문서는 제공자 공통 계약을 설명합니다.

## 구조

```text
사용자 마이크 → Web Audio → 제한된 PCM 큐 → provider.input()
                                                   |
                                             AI 음성 런타임
                                                   |
스피커 재생 ← Web Audio ← 응답 ID 검증 ← context.emit(audio)
                                 ↖ 상태·최종 발화문
```

공개 진입점은 `createAgentHuddle({ provider, openAudio, signal? })`입니다.
기존 통화 컨트롤러를 재사용하고 내부의 직접 연결 어댑터가 AI 제공자에 PCM을 전달합니다.
이 경로에서 Relay HTTP·WebSocket, Nostr 신원, Opus 또는 임시 방을 사용하지 않습니다.

원본 `features/huddle/voice.ts`와 `AgentVoiceSeat`의 `input`, `output`, abort, close 수명을
기반으로 분리했습니다. 원본의 앱 내 에이전트 검색·방 멤버십은 가져오지 않았습니다.
`AgentVoiceProvider`는 선택한 런타임으로 이 파이프를 연결하는 호스트입니다.

## 제공자 API

```ts
import type {
  AgentVoiceProvider,
  AgentVoiceContext,
  AgentVoiceConnection,
} from "huddle-lab/agent-voice";
```

`AgentVoiceProvider`는 `id`, `name`, `open(context)`를 제공합니다. `open`은
`AgentVoiceConnection`을 반환하고 핸들은 다음 메서드를 구현합니다.

| 메서드 | 계약 |
| --- | --- |
| `input(samples)` | 사용자 마이크의 정규화된 48 kHz 모노 PCM 수신. 직접 연결 경로는 960 samples(20ms)씩 전달 |
| `interrupt(responseId)` | 해당 응답과 아직 ID가 없는 대기 추론까지 취소 |
| `close()` | 멱등적 정리. 진행 중인 입력·취소·미디어 작업을 마치고 세션을 해제한 뒤 완료 |

`context`는 통화별 `id`, `signal`, `emit(event)`를 제공합니다. API 키, 모델 ID,
로그인과 에이전트의 도구 권한은 이 코어가 관리하지 않습니다. 음성 파이프는 도구 실행
권한이 아니며 실제 에이전트 런타임의 기존 권한 정책을 적용해야 합니다.

## 이벤트 순서

제공자는 실제 세션의 이벤트를 다음으로 변환합니다.

```ts
context.emit({ type: "activity", activity: "thinking" });
context.emit({ type: "response-started", responseId: "unique-response-1" });
context.emit({
  type: "audio",
  responseId: "unique-response-1",
  samples: normalized48kMonoFrame, // 정확히 960개, finite, 범위 [-1, 1]
});
context.emit({
  type: "transcript",
  id: "unique-final-line-1",
  speaker: "assistant", // 사용자 최종 발화는 "user"
  responseId: "unique-response-1",
  text: finalSpokenText,
});
context.emit({ type: "response-ended", responseId: "unique-response-1" });
```

응답 시작 이벤트는 음성보다 먼저, 응답 종료 이벤트는 모든 음성 출력 이후에 보냅니다.
통화 내 응답 ID는 재사용하지 않으며 시작 이벤트를 한 번만 보냅니다. 현재 응답 ID와 다른
오디오, 끝난 응답의 추가 오디오는 버립니다. 발화문은 partial이 아닌 최종 결과만 전달합니다.
보관한 ID·speaker가 같은 중복 발화문은 무시하며 최신 200개만 메모리에 보관합니다.
새 통화를 시작하면 기록을 비웁니다. 코어는 전사문을 파일이나 외부 채팅에 게시하지 않습니다.

모델이 24 kHz 등 다른 형식을 사용한다면 제공자가 48 kHz로 변환하고 960 samples로
묶어 전달해야 합니다. 코어는 샘플레이트를 추측하거나 모델 형식을 임의 변환하지 않습니다.
연결 완료 전에 도착한 응답 음성은 최신 4프레임(80ms)까지만 보관합니다.

`response-started`는 생각 중, 첫 오디오는 말하는 중, `response-ended`는 듣는 중으로
표시됩니다. 이는 제공자의 생성 수명이며 스피커의 마지막 예약 버퍼가 끝나는 시각과
완전히 같지는 않습니다. 중간 상태·오류를 제외한 음성 데이터 해석은 제공자가 담당합니다.

## 끼어들기

사용자가 `huddle.interrupt()`를 호출하면 예약된 AI 재생과 연결 전 대기 음성을 즉시
버리고 `connection.interrupt(responseId)`를 호출합니다. 취소된 응답 ID의 늦은 음성·최종
발화문을 무시합니다. 다음 응답은 새로운 ID로 시작해야 합니다.

제공자가 VAD로 사용자의 발화를 감지해 자체적으로 AI 응답을 취소했다면 다음 이벤트로
로컬 재생도 중단합니다.

```ts
context.emit({ type: "response-interrupted", responseId: "unique-response-1" });
```

이 이벤트는 제공자에 취소를 다시 요청하지 않습니다. VAD, 발화 종료 감지, 생성 취소 및
이미 응답 ID가 정해지지 않은 추론의 취소는 제공자 책임입니다. 이 코어는 마이크에서
사람이 말했는지를 판정하지 않습니다.

## 종료와 취소

`leave()`와 호스트 세션 abort는 마이크를 즉시 해제하고 제공자의 signal을 취소합니다.
열기·닫기가 진행 중이면 `leaving` 상태를 유지하며 새 연결을 받지 않습니다. 늦게 반환된
연결 핸들도 닫은 후에만 좌석을 해제합니다. 종료 후 늦은 오디오·발화문·상태는 무시합니다.

제공자는 signal을 관찰하고 `open`과 `close`를 유한한 시간 안에 완료해야 합니다.
코어가 취소를 보냈다는 사실만으로 미완료된 외부 작업의 종료를 가장하지 않습니다.
원격 네트워크 연결의 timeout과 로그아웃은 실제 제공자 어댑터에서 구현합니다.

제공자 종료는 `context.emit({ type: "ended", error? })`로 알립니다. 입력 전달이나 끼어들기의
실패도 정상적인 통화 정리 경로로 처리하며 수동 재시작 전까지 재연결하지 않습니다.
음소거는 사용자 입력만 차단하므로 AI가 이미 말하던 답변은 계속 들을 수 있습니다.

## 현재 예제와 검증 범위

`npm run demo:agent`는 `examples/browser/agent-fixture.js`의 테스트 제공자를 사용합니다.
테스트 음과 합성 발화문을 출력할 뿐 사용자 음성을 인식하거나 답변을 생성하지 않습니다.
실제 연결 화면은 `npm run demo:codex`로 실행합니다.

테스트는 입출력 연결, 상태, 발화문 제한, 응답 취소, 오래된 응답 차단, 연결/종료 경합과
세션 철회를 검사합니다. 브라우저에서는 가상 마이크와 실제 Web Audio를 사용해 캡처·재생과
끼어들기의 native AudioBuffer 중단을 확인합니다. 실제 모델의 인식·대화 품질, 지연,
자동 VAD와 에이전트 도구 실행은 아직 검증하지 않았습니다.
