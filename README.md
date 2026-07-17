# vramgate

`vramgate`는 단일 NVIDIA GPU를 여러 프로세스가 공유할 때 OOM을 줄이는 협조적 VRAM admission-control 브로커다. Node.js 20 이상만 필요하며 외부 패키지 의존성이 없다.

## 설치와 실행

```sh
npm install
node bin/vramgate daemon
node bin/vramgate status
```

기본 소켓은 `${XDG_RUNTIME_DIR:-/run/user/$UID}/vramgate.sock`이다. 사용자 systemd 서비스는 `systemd/vramgate.service`를 적절한 사용자 유닛 경로에 복사한 뒤 `systemctl --user enable --now vramgate`로 실행할 수 있다.

```sh
vramgate daemon --budget 15360 --reserve 1024 --safety 512
vramgate run --vram 8G --label sdxl -- python worker.py
vramgate hold --vram 8G --label gaming
vramgate status --json
```

`run`은 리스를 받은 뒤 명령을 실행하고 자식의 종료 코드를 그대로 전달한다. `hold`는 Ctrl-C까지 예약을 유지한다.

## Node 클라이언트

```js
import { VramgateClient } from 'vramgate';

const client = new VramgateClient({ socket: process.env.VRAMGATE_SOCKET });
await client.withLease(8 * 1024, { label: 'sdxl', priority: 0 }, async () => {
  // GPU 작업
});
```

`acquire(mib, options)`, `status()`, `withLease(mib, options, fn)`를 제공하고, 획득한 리스는 `lease.release()`로 해제한다. 기본 `failOpen: true`이므로 데몬이 없으면 no-op 리스를 반환해 기존 작업을 계속한다. 강제 적용이 필요하면 `failOpen: false`를 사용한다.

## 아키텍처

데몬은 Unix 소켓의 NDJSON 프로토콜로 요청을 받고 가중 카운팅 세마포어를 관리한다. 우선순위가 높은 요청부터, 같은 우선순위에서는 FIFO로 처리한다. 같은 연결에서 얻은 모든 리스는 그 연결이 닫힐 때 자동 해제된다.

`nvidia-smi`의 실측 사용량에서 활성 관리 리스를 뺀 값을 external 사용량으로 본다. 신규 요청은 관리 리스, external 사용량, 요청 비용과 안전 마진의 합이 물리 VRAM 상한 이내일 때만 승인한다. 실행 중인 작업을 선점하거나 종료하지 않는다.

## 수동 ComfyUI/게임 스트리밍 운용

ComfyUI처럼 직접 실행하는 프로그램도 래퍼로 예약할 수 있다.

```sh
vramgate run --vram 10G --label comfyui -- python main.py
vramgate run --vram 8G --label game-stream -- ./start-game.sh
```

게임을 별도 런처에서 실행해야 한다면 먼저 `vramgate hold --vram 8G --label gaming`으로 공간을 잡고, 종료 후 Ctrl-C로 해제한다. 프로그램을 vramgate로 감싸지 않아도 `nvidia-smi` 실측분이 external로 계산되므로 대기 중인 관리 작업은 자동으로 이를 피한다. 단, vramgate는 비선점 방식이라 이미 실행 중인 관리 작업이나 게임을 중단하거나 VRAM을 회수하지는 않는다.

## 향후 작업

- TODO: strict priority/FIFO의 head-of-line blocking을 완화하는 안전한 backfill 정책.

## 테스트

```sh
npm test
```

MIT License, Copyright (c) 2026 banip.
