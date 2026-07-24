# vramgate — 설계 문서 (구현 명세)

협조적(cooperative) VRAM 예산 브로커. 단일 GPU를 여러 독립 프로세스가 나눠 쓸 때 각 작업이 **로드 전에 리스(lease)를 획득**하게 한다. 일반 작업은 비선점이고, 유휴 트레이닝용 협조적 선점 리스를 선택적으로 제공한다.

## 목표 / 비목표
- 목표: 여러 프로세스의 VRAM 사용을 중앙에서 admission-control. `A(8G)+B(8G)` 동시 실행 후 `C(16G)`는 대기 → 자리 나면 실행. 반대 순서로 큐에 쌓여도 차례로 배차.
- 비목표: 하드 강제(advisory/협조적이며 데몬이 프로세스를 직접 종료하지 않음). 단일 GPU·단일 호스트·홈 규모.

## 아키텍처
- **데몬 `vramgated`**: 상주 프로세스. 예산 + 큐 소유. Unix 도메인 소켓 `${XDG_RUNTIME_DIR:-/run/user/$UID}/vramgate.sock`(설정 가능)에서 listen. **외부 의존성 0** (Node 내장 모듈만: `net`, `child_process`, `fs`).
- **프로토콜**: 소켓 위 NDJSON(줄바꿈 구분 JSON). request/response + 비동기 grant 이벤트. **연결 바인딩 리스**: 클라이언트 소켓이 닫히면(정상/크래시 무관) 그 연결의 모든 리스가 자동 해제된다(advisory file lock이 fd에 묶이는 것과 동일 원리).
- **클라이언트 라이브러리 `client.js`**: `acquire(mib, {priority,label,timeoutMs,preemptible,idleWindowMs})`, `lease.release()`, `lease.onPreempt(cb)`/`lease.preempted`, `status()`, `withLease(...)`.
- **CLI `bin/vramgate`**: `daemon` / `run` / `idle-run` / `hold` / `status`.

## 핵심: Admission 규칙
설정값:
- `TOTAL_MIB`: 관리 예산. 기본 = nvidia-smi로 감지한 `memory.total` − `RESERVE_MIB`.
- `RESERVE_MIB`: 데스크탑/컴포지터/여유분 기본 1024.
- `SAFETY_MIB`: 추가 안전 마진 기본 512.
- `SMI_POLL_MS`: nvidia-smi 폴링 주기 기본 2000.
- `GPU_INDEX`: 기본 0.
- `IDLE_THRESHOLD_MIB`: external 기반 유휴 판정 임계치, 기본 1536.

데몬 상태:
- `granted` = Σ(활성 리스 mib) — 관리(managed) 작업이 선언한 비용 합.
- 폴링으로 `live_used`, `live_total` 획득. `external = max(0, live_used − granted)` — **브로커 리스를 안 든 프로세스가 쓰는 VRAM**(직접 띄운 ComfyUI, 게임, 데스크탑 등).

큐에 있는 `cost` 요청은 **아래를 만족하면 admit**:

```
granted + external + cost + SAFETY_MIB ≤ TOTAL_MIB + RESERVE_MIB
```

즉 실질적으로 `granted + external + cost ≤ (live_total − SAFETY_MIB)`. 정리하면:
- 관리 작업 합(`granted`) + 미관리 작업 실측(`external`) + 신규 비용(`cost`)이 물리 VRAM(−마진) 안에 들어와야 한다.
- **external이 오르면**(사용자가 게임/ComfyUI 시작) 관리 작업 admission이 자동으로 빡빡해진다. external이 내리면 큐에 있던 관리 작업이 admit된다. → 미관리 사용을 자동 회피.
- 엣지: 방금 grant된 관리 작업이 아직 로드 전이면 `live_used < granted` → `external`이 음수가 되므로 `max(0, …)`로 0 클램프(정상). 리스보다 더 쓰는(under-declared) 관리 작업은 그 초과분이 external로 잡혀 보수적으로 더 조여짐 → 자기교정.

일반 리스는 비선점이다. 선점형은 `preemptible:true`, `idleWindowMs`, 기본 priority -100으로 요청한다.

```
busy := 비선점 활성 리스 존재
     OR 비선점 대기 요청 존재
     OR external > IDLE_THRESHOLD_MIB
```

데몬은 poll과 리스/큐 변화 때 busy이면 `lastBusyAt`을 갱신한다. 선점형 admission은 기존 VRAM 조건과 `now - lastBusyAt >= idleWindowMs`를 모두 요구한다. 활성 선점형 리스 중 busy가 되면 그 연결에 `{type:"preempt", leaseId}`를 한 번 보낸다. 데몬은 프로세스를 죽이거나 리스를 강제 해제하지 않는다. 비선점 작업만 선점 이벤트를 만들며 선점형끼리는 priority/FIFO로 순서를 정한다.

## 큐 / 공정성
- 우선순위 정수 내림차순, 동순위는 FIFO. 기본 priority 0.
- release나 external 감소 등 예산 변동 시 큐를 앞에서부터 재스캔해 **들어갈 수 있는 것들을 순서대로 모두** admit.
- v1은 엄격한 priority-FIFO(head-of-line). 앞의 큰 작업이 안 들어가면 뒤의 작은 작업도 대기한다(예측 가능성 우선).

### Backfill 설계 결정

현재 프로토콜에는 활성 리스와 대기 요청의 예상 종료 시각 또는 최대 실행시간이 없다. 선점형 리스도 데몬이 강제로 회수하지 않고 클라이언트에 협조 요청만 보낸다. 따라서 뒤의 작은 요청을 빈 공간에 승인하면, 기존 리스가 해제되어 선두 요청이 실행 가능해지는 시점에 그 작은 요청이 남아 선두를 지연할 수 있다. 이는 priority/FIFO 계약을 깨며 starvation도 만들 수 있다.

그러므로 실행시간 정보 없이 이루어지는 opportunistic backfill은 구현하지 않는다. 안전한 backfill을 추가하려면 다음 중 하나가 먼저 필요하다.

- 요청과 활성 리스가 신뢰 가능한 `expectedEndAt` 또는 강제 가능한 `maxRunMs`를 제공하고, 선두 요청의 예약 시작 시각 전에 끝나는 후보만 승인하는 보수적 예약 방식
- 데몬이 backfill 리스를 예약 시각에 확실히 회수할 수 있는 강제 종료·해제 메커니즘

두 경우 모두 예상 종료 위반 처리, aging/starvation 방지, 우선순위별 예약 규칙과 감사 로그를 함께 설계해야 한다. 홈서버의 장시간·종료시각 불명 작업에는 엄격한 priority/FIFO가 더 안전한 기본값이다.

## 리스 생명주기
- grant → `{leaseId, mib}`. 연결 바인딩(소켓 close = 그 연결 모든 리스 release). 명시적 `release`. TTL/heartbeat는 v1 선택(연결 바인딩으로 충분, 옵션 설정만 남겨둠).

## CLI
- `vramgate daemon [--budget MIB] [--reserve MIB] [--safety MIB] [--socket PATH] [--gpu N] [--poll MS]` — 브로커 실행(systemd 유닛도 이걸 호출).
- `vramgate run --vram 8G [--priority N] [--label L] [--wait-timeout S] -- <cmd...>` — 리스 획득 후 cmd를 자식으로 spawn, cmd 종료 시 release. **cmd exit code 그대로 전파.** ComfyUI/게임/수동 실행 래퍼가 이것.
- `vramgate idle-run --vram 12G --idle 5m [--priority -100] [--stop-grace 30s] [--label train] -- <cmd...>` — 유휴 grant 후 실행. preempt 시 SIGTERM, grace 뒤 SIGKILL, release 후 다시 등록한다. 자발 종료 시 해당 코드로 끝나고 Ctrl-C 시 자식 종료와 release를 수행한다.
- `vramgate hold --vram 8G [--label gaming]` — 획득 후 SIGINT(Ctrl-C)까지 유지. 게임 스트리밍 등 인터랙티브 예약용. 획득되면 메시지 출력.
- `vramgate status [--json]` — 예산, live used/free/total, external, 활성 리스(id·label·mib), 대기 큐(cost·priority·나이) 표시.
- 단위 파싱: `8G`/`8192M`/`8192`(기본 MiB), 시간은 `5m`/`30s`/`90`(기본 초).

## 클라이언트 API (Node)
```js
import { VramgateClient } from 'vramgate';
const c = new VramgateClient({ socket }); // socket 생략 시 기본 경로
await c.withLease(8*1024, { label:'sdxl', priority:0 }, async () => {
  // GPU 작업
});
// 또는
const lease = await c.acquire(8*1024, { label:'llm', timeoutMs: 0 });
try { /* ... */ } finally { await lease.release(); }
```
**failOpen(기본 true)**: 데몬 미기동/소켓 없음 등 연결 자체가 실패하면 no-op 리스로 진행한다. 연결 성공 후 대기는 `timeoutMs` 미지정/0이면 무기한이다. 양수인 timeout이 만료되면 요청을 cancel하고 `VramBusyError`를 던진다(fail-closed). `withLease`도 동일하다.

`status()`는 각 리스/큐 항목의 `preemptible` 정보와 데몬의 `busy`, `lastBusyAt`, `idleThreshold`를 노출한다.

## 서비스 연동 규약 (kamishibai/videogen/디코봇에서 사용)
각 서비스는 설정을 읽는다: 환경변수 `VRAMGATE_MODE=off|on`(기본 `off`), `VRAMGATE_SOCKET`, 작업별 비용 `VRAMGATE_COST_*`(예 `VRAMGATE_COST_SDXL`, `VRAMGATE_COST_LLM`).
- `off`(기본): 연동은 no-op 패스스루 → 현행 동작(일반 VRAM 사용).
- `on`: GPU 무거운 호출을 `client.withLease(cost, …)`로 감싼다.

## nvidia-smi 추상화 (`gpu.js`)
`nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits -i <index>` 실행. 마지막 정상값 캐시. 실패 시 bookkeeping-only(external=0, granted 기준)로 폴백하고 로그.

## 파일 구조
- `package.json` (name `vramgate`, `"type":"module"`, `bin`, `exports`로 client 노출, 의존성 0)
- `src/daemon.js` `src/client.js` `src/gpu.js` `src/protocol.js` `src/units.js`
- `bin/vramgate` (CLI 디스패치, `#!/usr/bin/env node`)
- `systemd/vramgate.service` (`--user` 유닛; `XDG_RUNTIME_DIR` 사용)
- `README.md`(사용법·아키텍처·수동 ComfyUI/게임 운용 섹션), `DESIGN.md`(본 문서), `LICENSE`(MIT)
- `test/` (`node:test`): 세마포어 admission, external 정합(모의 gpu), 연결 close 시 리스 해제, 단위 파싱.

## 테스트 요구
- gpu.js는 주입 가능한 형태(예: `{queryFn}`)로 만들어 테스트에서 nvidia-smi 없이 모의값 주입.
- 시나리오 테스트: A(8G)+B(8G) 동시 grant, C(16G) 대기 → A release 시에도 여전히 부족(8+16>15 예산 가정) 확인, A·B 모두 release 후 C grant. external을 6G로 올리면 신규 8G가 대기하는지.
