# Huddle Lab

Buzz 1.0.4의 Huddle 로직에서 분리한 TypeScript 코어 라이브러리입니다.
UI 프레임워크나 Tauri 없이 사용할 수 있으며 런타임 패키지 의존성이 없습니다.

현재 단계에서는 실제 마이크나 Relay에 연결하지 않습니다. 해당 기능은 호스트가
어댑터로 제공합니다. 라이브러리는 호출 순서, 통화 상태, 취소와 자원 정리를 담당합니다.

## 실행

Node.js 20 이상에서 저장소 루트 기준으로 실행합니다.

```sh
npm ci
npm test
npm run demo
```

`demo`는 메모리 내 어댑터로 참여 → PCM 전달 → 음소거 → 종료를 실행합니다.
실제 음성 통화 데모는 아닙니다. `npm run build`는 ESM 코드와 타입 선언을 `dist/`에
생성하고, `npm run typecheck`는 타입만 검사합니다.

## 현재 제공하는 기능

| API | 역할 |
| --- | --- |
| `createHuddles(options)` | 단일 통화 컨트롤러 생성 |
| `start(destination)` | 기존 방 탐색 후 참여, 없으면 어댑터에 방 생성 요청 |
| `join(destination, room)` | 지정한 방에 참여 |
| `snapshot()` / `subscribe(listener)` | 불변 상태 조회 및 변경 구독 |
| `mute()` | 송신 음소거 전환 및 대기 PCM 폐기 |
| `leave()` | 로컬 마이크·전송·heartbeat 정리 |
| `invalidate(reason)` | 세션·권한 변경 시 통화를 종료하고 오류 노출 |
| `dispose()` | 컨트롤러 영구 종료 및 구독 정리 |
| `recentHuddles()` / `discoverHuddles()` | 기존 프로토콜의 방 탐색 |
| `huddleDescription()` / `huddleParent()` / `huddleRoom()` / `isHuddleRoom()` | 방 메타데이터 해석 |
| `huddleLifecycle()` | 시작·종료·참가 이력 해석 |
| `createPcmSender()` | 직렬 PCM 전송 및 대기 프레임 제한 |

컨트롤러의 상태는 `idle → connecting → connected → leaving → idle`이며,
실패는 `error`로 표시됩니다. `start()`와 `join()`의 Promise는 호스트의 `open()`이
끝나면 완료됩니다. 실제 연결 여부는 `connected` 상태로 판단해야 합니다.
통화 도중이나 종료 처리 중의 추가 참여 요청은 무시됩니다. 자동 재접속은 없습니다.

## 호스트가 구현할 계약

`src/types.ts`와 `src/controller.ts`에서 공개 타입을 확인할 수 있습니다.
실행 가능한 연결 예제는 [examples/controller.mjs](examples/controller.mjs)에 있습니다.

- `authorize(destination, room, signal)`: 현재 신원·커뮤니티·접근 권한을 확인하고
  실패 시 reject합니다. 방이 없는 시작 요청은 원래 채널의 멤버십을 확인해야 합니다.
  이 검사는 마이크를 열기 전에 실행됩니다.
- `discover(destination, signal)`: 최신순으로 정렬한 참여 후보를 반환합니다.
  첫 후보를 사용하며, 실패한 후보에서 새 방 생성으로 자동 전환하지 않습니다.
- `bridge`: 인증 및 최종 참여 권한 검사, 방 생성, 오디오 전송, 참가자 업데이트를
  담당합니다. 실제 연결 시 `connected`, 명단 변경 시 `participants`, 수신 PCM은
  `audio`, 연결 종료 시 `ended` 이벤트를 전달합니다.
- `openAudio(send, ended, signal)`: 마이크와 재생 장치를 관리합니다. 마이크 PCM은
  `send`로 보내고, 장치가 끊기면 `ended`를 호출합니다. 반환된 오디오 핸들에서
  음소거·수신 재생·참가자 자원 정리·종료를 구현합니다.

사용자가 명시적으로 참여를 눌렀을 때 `start()` 또는 `join()`을 호출하세요.
호스트의 신원·세션·멤버십이 바뀌면 `invalidate()`를 호출하고, 호스트 기능을
비활성화할 때 `dispose()`를 기다려야 합니다. 단순 화면 전환에는 호출하지 않습니다.

`openAudio`는 abort를 처리하고 늦게 승인된 마이크도 해제해야 합니다.
컨트롤러는 늦게 반환된 핸들도 닫습니다. `bridge.open()`은 실패하더라도 반드시
settle되어야 합니다. 종료는 진행 중인 open이 끝난 뒤 같은 ID의 `close()`를 호출하며,
close는 없는 ID에도 안전해야 합니다. 호스트의 네트워크 연결에는 유한한 timeout을 두세요.
컨트롤러는 `open()` 완료 후 5초마다 `touch()`를 호출합니다.

오디오 계약은 48 kHz 모노 PCM이며 송신은 프레임당 960 samples(20ms)입니다.
송신 큐는 대기 4개와 진행 중인 1개를 유지하고, 넘치면 오래된 대기 프레임을 버립니다.
이미 호스트로 전달한 프레임은 취소할 수 없습니다.

## 신뢰 경계와 분리 범위

이벤트 해석 함수는 암호학적 서명을 검증하지 않습니다. `LifecycleEvent`는 payload
타입이며 검증 증명이 아닙니다. 호스트가 서명 검증과 Relay 신뢰 확인을 마친 이벤트만
입력해야 합니다. parent description도 파싱 결과일 뿐입니다. 원본 앱의 검증된
kind-9007 생성 receipt와 Relay 메타데이터 확인은 호스트의 책임입니다.
오디오 참여 사실만으로 채팅 쓰기 권한을 부여하면 안 됩니다.

이 코어에는 UI, 별도 창, 수신 요청·벨소리, 장치 선택, 채팅, 에이전트 음성 좌석,
Nostr 서명·인증, Opus/WebSocket 구현, 방 자동 archive가 포함되지 않습니다.
`leave()`는 로컬 통화 종료이며 방 전체의 종료 공지나 archive를 자동 수행하지 않습니다.

원본의 방 탐색은 kind `48100`/`48103`과 3600초 TTL을 사용합니다.
참가 이력은 Relay가 발행한 `48101`/`48102`를 해석합니다.
방 생성 `9007`, 멤버십 확인 `9000`, 최종 권한 검사와 서버 측 정리는 향후 어댑터 범위입니다.

## 추출 단계와 출처

1. 완료: 순수 함수, 전송 큐, 주입 가능한 통화 컨트롤러, 공개 타입 및 테스트.
2. 다음: Web Audio 어댑터를 별도 모듈로 분리하고 실제 마이크 입출력 확인.
3. 이후: 원하는 호스트에 맞춰 인증·Relay 연결 어댑터 구현 및 실제 2인 통화 확인.

원본은 `block/buzz-app`의 `v1.0.4`, 커밋
`a1c9c96940d2a6c81fce9beed9b7cbcc34b144b8`입니다.
`lifecycle.ts`, `discovery.ts`, `sender.ts`는 원본 동작을 유지하며 앱 전용 타입을
교체했습니다. 컨트롤러는 `service.ts`의 통화 수명 처리를 독립 계약에 맞게 수정했습니다.
원본 저장소를 실행하거나 이웃 경로에서 import할 필요가 없습니다.

라이선스와 수정 내역은 [LICENSE](LICENSE), [NOTICE](NOTICE)를 확인하세요.
로컬 개발용으로 `private: true`를 설정했으며 패키지 배포는 하지 않았습니다.
