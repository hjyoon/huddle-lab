# Relay 어댑터

`huddle-lab/relay`는 원본 Buzz 1.0.4의 Huddle 제어 흐름을 TypeScript 호스트 계약으로
옮긴 모듈입니다. REST와 WebSocket은 실제 네트워크 연결이며, 개인 키를 받거나 저장하지 않습니다.

## 호스트 연결

```ts
import { createHuddles } from "huddle-lab";
import { createRelayAdapter } from "huddle-lab/relay";
import { openWebAudio } from "huddle-lab/web-audio";
import { createWebCodecsCodec } from "huddle-lab/webcodecs";

const relay = createRelayAdapter({
  relayUrl: "https://relay.example.org",
  relayPubkey: trustedRelayPubkey,
  scope: currentSessionScope,
  identity: { pubkey: currentViewerPubkey, signEvent: hostSignEvent },
  createCodec: createWebCodecsCodec,
  signal: hostSessionAbort.signal,
});
const huddle = createHuddles({ ...relay, openAudio: openWebAudio });

// 사용자가 명시적으로 참여를 누를 때 호출합니다.
await huddle.start({
  relayUrl: "https://relay.example.org", scope: currentSessionScope,
  viewer: currentViewerPubkey, channelId: parentChannelId, channelName: "Team",
});
// 호스트 기능을 종료할 때 두 모듈의 정리를 기다립니다.
await huddle.dispose();
await relay.dispose();
```

예제의 키·세션·서명 함수는 호스트가 제공하는 값입니다. 서명 함수는 `EventTemplate`을 받아
Nostr 서명 이벤트를 반환합니다. 어댑터는 반환된 이벤트의 ID, BIP-340 서명,
공개 키와 요청한 kind/시각/tags/content가 모두 일치하는지 검사합니다.
개인 키를 설정 파일이나 브라우저 저장소에 넣는 API는 제공하지 않습니다.

`relayPubkey`는 신뢰하는 커뮤니티의 공개 키로 고정해야 합니다. 응답 본문이 주장하는 키를
그대로 신뢰하지 않습니다. `scope`, `viewer`, Relay origin이 어댑터 설정과 다르면 요청 전에
거절합니다. HTTPS origin만 허용하며 로컬 개발용 HTTP는 loopback 주소에 한정합니다.

## 인증과 접근 권한

- `/query`, `/events` POST는 NIP-98(kind 27235) 서명을 사용합니다. URL·메서드·본문 SHA-256·nonce를
  서명하며, HTTP 리다이렉트와 자동 재시도는 하지 않습니다.
- 읽은 이벤트는 저장된 검증 플래그에 의존하지 않고 ID와 BIP-340 서명을 다시 검사합니다.
  Relay가 서명한 `39000` 메타데이터와 `39002` 명단으로 현재 멤버십과 archive 상태를 확인합니다.
- 새 방은 원래 대화의 멤버만 만들 수 있습니다. 기존 방의 직접 초대만으로 참여할 때는
  생성자의 정확한 kind-9007 receipt에서 private stream 및 원래 채널 marker를 검증합니다.
- 오디오가 원래 대화의 멤버를 방에 자동 추가하면, 연결 후 self `9000`을 발행하고 방 명단을
  다시 읽습니다. 확인하지 못하면 `connected`로 표시하지 않습니다.
- `/huddle/{room}/audio` WebSocket의 challenge에 NIP-42(kind 22242)로 응답하고
  `protocol_version: 2`, `parent_channel_id`를 전달합니다. 입장 허용의 최종 판단은 서버가 합니다.

NIP-FI 커뮤니티에서는 기존 로그인에서 발급받은 증거를 호스트가 공급합니다.

```ts
authorization: async (signal) => ({
  header: hostAuthorizationHeader,
  expiresAt: hostAuthorizationExpiresAtMs,
  signal: hostAuthorizationRevoked.signal,
}),
createSocket: (url, headers) => hostWebSocketWithHeaders(url, headers),
```

증거는 설정된 Relay origin과 사용자에게 발급된 것이어야 합니다. REST 및 socket upgrade에
`Nostr-Federated-Identity` 헤더로만 붙이며 URL에 넣지 않습니다. 만료·철회되면 통화를 종료합니다.
자동 로그인·갱신·재접속은 없습니다. 순수 브라우저 WebSocket은 upgrade 헤더를 설정할 수
없으므로 NIP-FI가 필요한 곳은 native/Node 같은 신뢰하는 호스트의 socket factory가 필요합니다.
일반 브라우저의 REST 접속에는 대상 Relay의 적절한 CORS 설정도 필요합니다.

이 모듈은 멤버십 전체를 주기적으로 재조회하지 않습니다. 호스트가 세션·신원·권한 변경을
관찰해 `huddle.invalidate(reason)`을 호출하거나 어댑터에 제공한 호스트 세션 `signal`을
취소해야 합니다. 반환된 어댑터를 코어 옵션에 펼치면 이 세션 signal도 전달되어
마이크 권한 승인 대기 중에도 취소됩니다. `authorization()`이 반환한 증거의 signal은
그 증거를 사용하는 요청/오디오 연결을 철회하는 범위이며 호스트 세션 signal을 대체하지 않습니다.
서버가 연결 중 철회한 입장 권한은 socket의 오류·종료로 반영됩니다.

## 오디오와 수명

v2 송신은 8바이트 big-endian header와 Opus payload, 수신은 그 앞에 1바이트 peer index가
붙습니다. sequence는 u16, 48kHz timestamp는 u32이며 각각 wrap합니다.
실제 미디어는 48kHz 모노, 20ms당 960 samples입니다.

`createCodec(output, failed)`는 Opus 호스트를 생성합니다. `encode()`는 PCM을 제출하고
패킷은 `output()`으로 비동기 전달합니다. 인코더의 lookahead 때문에 매 제출마다 flush하지
않습니다. `decode(index, opus)`는 참가자별 PCM을 반환하고 `remove(index)`는 재할당된
decoder를 초기화합니다. native/WASM 구현도 같은 계약으로 주입할 수 있습니다.

기본 WebCodecs 구현은 32kbit/s Opus를 요청합니다. 송신의 인코딩 대기는 최대 5프레임,
socket buffer 상한은 최대 크기 패킷 5개분입니다. 수신의 decode 대기는 참가자당 5개,
decoded PCM은 기기당 최대 200ms입니다. 10ms마다 같은 공개 키의 여러 기기를 섞고 합산 후
clip합니다. 참가자 교체 시 대기 PCM과 decoder를 버리고 늦은 완료 결과를 무시합니다.

수신은 고정 크기 버퍼 방식이며 원본 Rust의 NetEQ 적응형 jitter buffer나 packet loss
concealment와 동등하지 않습니다. v2 미디어에는 occupancy epoch가 없으므로 index 재할당 후
이전 사용자의 지연 패킷을 완전히 구별할 수 없는 한계도 원본과 같습니다.

HTTP와 오디오 admission은 각각 유한한 15초 제한을 둡니다. 진행 중 open에도 core의 abort를
전달합니다. `touch()`가 20초 넘게 없으면 로컬 연결을 종료합니다. 브라우저에서는 WebSocket
ping/pong이 JS에 노출되지 않으므로 native의 수신 프레임 timeout을 흉내 내지 않습니다.
네트워크 keepalive는 서버/호스트 socket이 맡고 JS 컨트롤러는 native 프로세스 lease를 대체하지 않습니다.

방 생성에 실패했고 시작 공지를 아직 시도하지 않았다면 `9002`로 정리합니다. 공지를
시도한 뒤에는 다른 사람이 이미 들어왔을 수 있어 연결 실패만으로 방을 archive하지 않습니다.
일반 `leave()`도 로컬 통화만 종료하며 전체 방 종료/보관은 Relay의 정리·TTL에 맡깁니다.

## 검증과 남은 범위

`npm test`는 실제 서명과 loopback HTTP/WS로 제어·접근·취소·receipt 경합을 확인합니다.
이 계층의 transport 테스트 codec은 제어 흐름을 분리하기 위한 투명 PCM fixture입니다.
`npm run test:browser`는 실제 Chrome WebCodecs Opus와 가상 마이크 두 개로 양방향 음성
패킷, 참가자 변경, 음소거, 독립 종료와 자원 해제를 확인합니다.

`npm run demo:relay`는 개발용 fixture 서버를 실행합니다. 이 서버는 nonce replay 저장,
운영 권한 모델, 영속성, 분산 routing, rate limit 또는 NIP-FI 검증 서비스를 구현하지 않습니다.
운영 환경에 배포할 서버가 아닙니다.

외부 Buzz Relay, 실제 NIP-FI 제공자, TLS/CORS 운영 설정, 물리 마이크의 두 사람 통화,
Safari/WebKit 및 장시간 background 통화는 검증하지 않았습니다.

프로토콜 출처:

- [Buzz 1.0.4 Huddle native owner](https://github.com/block/buzz-app/blob/a1c9c96940d2a6c81fce9beed9b7cbcc34b144b8/src-tauri/src/relay/huddle.rs)
- [고정된 audio handshake](https://github.com/block/buzz/blob/630922a9e1f891380a61f5b7d726d05ca948cc64/crates/buzz-audio-client/src/connection.rs)
- [고정된 v2 wire format](https://github.com/block/buzz/blob/630922a9e1f891380a61f5b7d726d05ca948cc64/crates/buzz-audio-client/src/wire.rs)
- [W3C WebCodecs](https://www.w3.org/TR/webcodecs/)
