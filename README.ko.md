# vramgate

*[English](README.md) · 한국어*

`vramgate`는 하나의 NVIDIA GPU를 여러 프로세스가 나눠 쓸 때 OOM(메모리 부족)을 줄여 주는 협조적 VRAM admission-control 브로커입니다. Node.js 20 이상만 있으면 되고, 외부 패키지 의존성이 없습니다.

## 설치와 실행

```sh
npm install
node bin/vramgate daemon
node bin/vramgate status
```

기본 소켓 경로는 `${XDG_RUNTIME_DIR:-/run/user/$UID}/vramgate.sock`입니다. systemd 사용자 서비스로 상주시키려면 `systemd/vramgate.service`를 사용자 유닛 경로에 복사한 뒤 `systemctl --user enable --now vramgate`로 실행합니다.

```sh
vramgate daemon --budget 15360 --reserve 1024 --safety 512 --idle-threshold 1536
vramgate run --vram 8G --label sdxl -- python worker.py
vramgate idle-run --vram 12G --idle 5m --stop-grace 30s --label train -- python train.py
vramgate hold --vram 8G --label gaming
vramgate status --json
```

- `run` — 리스를 받은 뒤 명령을 실행하고, 자식 프로세스의 종료 코드를 그대로 전달합니다.
- `hold` — Ctrl-C를 누를 때까지 예약을 유지합니다.
- `idle-run` — GPU가 지정한 시간만큼 유휴 상태이면 저우선순위 작업을 실행합니다. 도중에 일반 요청이 들어오면 자식에 SIGTERM을 보내고(기본 30초 뒤 SIGKILL), 리스를 해제한 뒤 다시 유휴 상태가 되기를 기다렸다가 재시작합니다. 자식이 스스로 끝나면 그 종료 코드로 종료합니다. 체크포인트 저장·재개는 자식 프로그램이 책임집니다.

## Node 클라이언트

```js
import { VramBusyError, VramgateClient } from 'vramgate';

const client = new VramgateClient({ socket: process.env.VRAMGATE_SOCKET });
await client.withLease(8 * 1024, { label: 'sdxl', priority: 0 }, async () => {
  // GPU 작업
});

const training = await client.acquire(12 * 1024, {
  preemptible: true,
  idleWindowMs: 5 * 60_000
});
training.onPreempt(() => stopTraining());
await training.preempted; // 콜백 대신 Promise로도 대기 가능
```

`acquire(mib, options)`, `status()`, `withLease(mib, options, fn)`를 제공합니다. 연결 자체가 실패하면 기본값 `failOpen: true`에 따라 no-op 리스를 반환합니다. 연결에 성공한 뒤의 큐 대기는 `timeoutMs`가 없거나 0이면 무기한이며, 양수이면 만료 시 fail-open하지 않고 `VramBusyError`를 던집니다. `withLease`에도 같은 정책이 적용됩니다.

## 아키텍처

데몬은 Unix 소켓의 NDJSON 프로토콜로 요청을 받아 가중 카운팅 세마포어를 관리합니다. 우선순위가 높은 요청을 먼저, 같은 우선순위끼리는 FIFO로 처리합니다. 한 연결에서 얻은 모든 리스는 그 연결이 닫히면 자동으로 해제됩니다.

`nvidia-smi` 실측 사용량에서 활성 관리 리스를 뺀 값을 external 사용량으로 봅니다. 신규 요청은 (관리 리스 + external 사용량 + 요청 비용 + 안전 마진)의 합이 물리 VRAM 상한 이내일 때만 승인합니다.

GPU 조회는 마지막 정상 실측값을 잠깐 재사용하되, 기본 3회 연속 실패하면 신규 리스 승인을 중단합니다. 정상 실측이 돌아오면 대기열 처리를 자동으로 재개합니다. 임계값은 `--gpu-failure-limit` 또는 `VRAMGATE_GPU_FAILURE_LIMIT`로 바꿀 수 있습니다. 시작 직후 정상 실측을 한 번도 얻지 못한 상태에서는 곧바로 승인을 차단합니다.

busy는 비선점 활성 리스나 대기 요청이 있거나, external이 `--idle-threshold`(기본 1536 MiB)를 넘을 때 참이 됩니다. 선점형 리스는 VRAM 조건과 `idleWindowMs` 동안 유휴였다는 조건을 모두 만족해야 승인됩니다. 승인 이후 busy 상태가 되면 데몬은 클라이언트에 `preempt` 이벤트만 보내며, 프로세스를 직접 종료하지는 않습니다. `status`에는 `busy`, `lastBusyAt`, `idleThreshold`와 각 리스·큐의 선점형 정보가 포함됩니다.

## 운영 감사 로그

데몬은 `queue`, `grant`, `release`, `cancel`, `preempt`, GPU 조회 차단·복구 이벤트를 `vramgate:audit` 접두사가 붙은 한 줄 JSON으로 표준 출력에 기록합니다. systemd 환경에서는 다음처럼 조회합니다.

```sh
journalctl --user -u vramgate -g 'vramgate:audit'
```

리스 로그에는 label·MiB·우선순위·대기 시간·보유 시간·해제 사유가 담겨 있어, 사후에 작동 횟수와 병목을 집계할 수 있습니다.

## 수동 ComfyUI / 게임 스트리밍 운용

ComfyUI처럼 직접 실행하는 프로그램도 래퍼로 예약할 수 있습니다.

```sh
vramgate run --vram 10G --label comfyui -- python main.py
vramgate run --vram 8G --label game-stream -- ./start-game.sh
```

게임을 별도 런처에서 실행해야 한다면, 먼저 `vramgate hold --vram 8G --label gaming`으로 공간을 잡아 두고 종료 후 Ctrl-C로 해제합니다. 프로그램을 vramgate로 감싸지 않더라도 `nvidia-smi` 실측분이 external로 계산되므로, 대기 중인 관리 작업은 자동으로 이 사용량을 피해 갑니다. 다만 vramgate는 비선점 방식이라, 이미 실행 중인 관리 작업이나 게임을 중단하거나 그 VRAM을 회수하지는 않습니다.

## Custodian

Custodian은 Ollama나 ComfyUI가 idle 상태로 붙들고 있는 상주 모델 VRAM을 선점 가능한 캐시 리스로 등록해 두고, 다른 작업이 공간을 요구하면 그 모델을 언로드해 VRAM을 회수합니다. 백엔드별 서비스는 다음으로 활성화합니다.

```sh
systemctl --user enable --now vramgate-custodian@ollama
systemctl --user enable --now vramgate-custodian@comfyui
```

## 향후 작업

- TODO: strict priority/FIFO의 head-of-line blocking을 완화하는 안전한 backfill 정책.

## 테스트

```sh
npm test
```

MIT License, Copyright (c) 2026 banip.
