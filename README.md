# Huddle Lab

Buzz 1.0.4의 Huddle 로직에서 분리한 TypeScript 코어 라이브러리입니다.
UI 프레임워크나 Tauri 없이 사용할 수 있습니다. 코어와 Web Audio는 프레임워크에
의존하지 않으며, 선택적 Relay 어댑터는 BIP-340 검증에 `@noble/curves`를 사용합니다.

코어는 호출 순서, 통화 상태, 취소와 자원 정리를 담당합니다.
선택적으로 `huddle-lab/web-audio` 어댑터를 연결해 실제 마이크와 스피커를 사용할 수 있습니다.
`huddle-lab/relay`는 서명된 REST와 Huddle v2 WebSocket 연결을 제공합니다.
서명 키·커뮤니티 로그인은 호스트가 관리하고 브라우저 Opus는 `huddle-lab/webcodecs`로 연결합니다.

## 실행

Node.js 20.19 이상에서 저장소 루트 기준으로 실행합니다.

```sh
npm ci
npm test
npm run demo
```

`demo`는 메모리 내 어댑터로 참여 → PCM 전달 → 음소거 → 종료를 실행합니다.
실제 음성 통화 데모는 아닙니다. `npm run build`는 ESM 코드와 타입 선언을 `dist/`에
생성하고, `npm run typecheck`는 타입만 검사합니다.

## 브라우저 오디오 확인

```sh
npm run demo:audio
```

출력된 `http://127.0.0.1:4173`을 열고 **마이크 시작**을 누른 뒤 권한을 허용합니다.
말할 때 입력 레벨과 프레임 수가 변하고, 음소거하면 두 값의 증가가 멈춥니다.
**재생 테스트**는 짧은 테스트 음을 재생하며 **종료**는 마이크와 오디오 컨텍스트를 해제합니다.
내 목소리 재생은 기본으로 꺼져 있습니다. 이어폰을 사용한 상태에서 선택해 확인하세요.
브라우저 내 로컬 확인이므로 녹음 저장이나 원격 음성 전송은 하지 않습니다.

포트가 사용 중이면 `HUDDLE_DEMO_PORT=4174 npm run demo:audio`처럼 변경합니다.
서버는 `127.0.0.1`에만 바인딩하며 예제와 빌드된 파일만 제공합니다.

브라우저 자동 테스트는 기본적으로 설치된 Google Chrome을 사용합니다.

```sh
npm run test:browser
```

Chrome이 없는 환경에서는 `npx playwright install chromium`으로 테스트용 브라우저를
설치한 뒤 `HUDDLE_BROWSER_CHANNEL=chromium npm run test:browser`를 사용합니다.
자동 테스트는 가상 마이크와 실제 브라우저의 AudioWorklet/Web Audio를 사용합니다.
물리 마이크·스피커 음질, 기기별 권한 동작과 Safari/WebKit은 아직 확인하지 않았습니다.

## Web Audio 어댑터 연결

```ts
import { createHuddles } from "huddle-lab";
import { openWebAudio } from "huddle-lab/web-audio";

const huddles = createHuddles({
  ...hostOptions, // 호스트가 구현한 authorize, discover, bridge
  openAudio: openWebAudio,
});
```

어댑터는 `OpenHuddleAudio` 계약을 구현하며 기본 마이크와 기본 스피커를 사용합니다.
장치 선택 UI는 포함하지 않습니다. 패키지 루트는 브라우저 API를 불러오지 않고,
`web-audio` 모듈도 import만으로 마이크를 열지 않습니다. 실행에는 HTTPS 또는 localhost의
AudioWorklet 지원 브라우저와 사용자의 명시적 시작 동작이 필요합니다.

기본 worklet은 배포 파일 `dist/web-audio/capture.worklet.js`와 함께 제공됩니다.
번들러가 자산 URL을 처리하지 않거나 별도 경로로 제공한다면 다음처럼 지정합니다.

```ts
import { createWebAudioAdapter } from "huddle-lab/web-audio";
const openAudio = createWebAudioAdapter({ workletUrl: "/assets/capture.worklet.js" });
```

위 경로에 worklet 파일을 복사하고 호스트의 CSP와 오리진 정책이 모듈 로딩을 허용해야 합니다.
마이크가 분리되거나 worklet이 실패하면 자원을 정리하고 `ended()`를 호출합니다.
정상 종료·abort에는 `ended()`를 호출하지 않습니다. 수신 재생은 참가자별로 관리하고,
최초 60ms 여유·underrun 후 20ms 재시작·200ms 예약 시작 상한을 원본처럼 유지합니다.

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
| `createRelayAdapter()` (`huddle-lab/relay`) | NIP-98 REST, 검증된 멤버십/방 탐색, 방 생성, NIP-42 오디오 연결 |
| `createWebCodecsCodec()` (`huddle-lab/webcodecs`) | 브라우저 Opus 인코딩 및 참가자별 디코딩 |

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

패키지 루트 코어에는 UI, 별도 창, 수신 요청·벨소리, 장치 선택, 채팅, 에이전트 음성 좌석,
Nostr 인증, Opus/WebSocket 구현, 방 자동 archive가 포함되지 않습니다.
인증·연결·Opus는 별도 subpath 모듈로 선택해 사용합니다.
`leave()`는 로컬 통화 종료이며 방 전체의 종료 공지나 archive를 자동 수행하지 않습니다.

원본의 방 탐색은 kind `48100`/`48103`과 3600초 TTL을 사용합니다.
참가 이력은 Relay가 발행한 `48101`/`48102`를 해석합니다.
Relay 어댑터가 방 생성 `9007`, 시작 공지 `48100`, 멤버십 확인 `9000`과
공지 전 실패한 생성의 정리 `9002`를 처리합니다. 서버의 최종 입장 검사와 만료 정리는 Relay의 책임입니다.

## 로컬 Relay로 두 사용자 통화 확인

```sh
npm run demo:relay
```

터미널의 **User A**, **User B** 링크를 각각 열고 **통화 시작**을 누릅니다.
두 사용자가 같은 방에 들어오면 참가자가 2명으로 표시되고 수신 프레임 수가 증가합니다.
실제 마이크 음성은 이 컴퓨터의 Relay를 통해 다른 탭으로 전달됩니다.
기본 주소는 `http://127.0.0.1:4180/examples/browser/relay.html?peer=0`과 `?peer=1`입니다.
`HUDDLE_RELAY_PORT=4181 npm run demo:relay`로 포트를 바꿀 수 있습니다.

이 서버는 **개발용 프로토콜 fixture**입니다. 키·사용자·방을 메모리에만 만들고,
종료하면 버립니다. 데모의 로컬 서명 endpoint는 이 임시 키만 사용합니다.
운영 계정 키를 넣거나 운영 Relay로 배포하지 않습니다. 원격 서비스에는 연결하지 않습니다.
원본 Buzz Relay와의 호환성은 실제 서버에서 별도로 확인해야 합니다.

실제 호스트 연결 방법과 검증 범위는 [Relay 어댑터 안내](docs/relay.md)를 확인하세요.

## 추출 단계와 출처

1. 완료: 순수 함수, 전송 큐, 주입 가능한 통화 컨트롤러, 공개 타입 및 테스트.
2. 구현·자동 검증 완료: Web Audio 어댑터 분리, 로컬 마이크/재생 예제,
   가상 마이크를 사용한 실제 Chrome 캡처·재생·정리 확인. 물리 장치 확인은 남아 있습니다.
3. 구현: 인증·Relay 어댑터, 브라우저 Opus, 두 사용자 로컬 통화 예제.
   로컬 HTTP/WS의 실제 서명 검사와 Chrome 가상 마이크 2개의 Opus 송수신을 검증합니다.
   운영 Buzz Relay, 실제 두 사람의 물리 마이크 통화와 Safari/WebKit은 별도 확인이 필요합니다.

원본은 `block/buzz-app`의 `v1.0.4`, 커밋
`a1c9c96940d2a6c81fce9beed9b7cbcc34b144b8`입니다.
`lifecycle.ts`, `discovery.ts`, `sender.ts`는 원본 동작을 유지하며 앱 전용 타입을
교체했습니다. 컨트롤러는 `service.ts`의 통화 수명 처리를 독립 계약에 맞게 수정했습니다.
Web Audio 어댑터는 `audio.ts`, `playout.ts`, `capture.worklet.js`에서 분리했습니다.
Relay 프로토콜은 원본의 Rust Huddle 코드와, 원본이 고정해 사용하던 `block/buzz`
커밋 `630922a9e1f891380a61f5b7d726d05ca948cc64`의 `buzz-audio-client`를 기준으로 구현했습니다.
원본 저장소를 실행하거나 이웃 경로에서 import할 필요가 없습니다.

라이선스와 수정 내역은 [LICENSE](LICENSE), [NOTICE](NOTICE)를 확인하세요.
로컬 개발용으로 `private: true`를 설정했으며 패키지 배포는 하지 않았습니다.
