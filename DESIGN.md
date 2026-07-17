# vramgate — 설계 문서 (구현 명세)

협조적(cooperative) VRAM 예산 브로커. 단일 GPU(예: 16GB)를 여러 독립 프로세스(LLM 추론, SDXL 이미지 생성 등)가 나눠 쓸 때, 각 작업이 VRAM 비용을 선언하고 **로드 전에 리스(lease)를 획득**하도록 해 OOM을 방지한다. 가중 카운팅 세마포어 + FIFO 큐 + nvidia-smi 실측 정합. 비선점(non-preemptive).

## 목표 / 비목표
- 목표: 여러 프로세스의 VRAM 사용을 중앙에서 admission-control. `A(8G)+B(8G)` 동시 실행 후 `C(16G)`는 대기 → 자리 나면 실행. 반대 순서로 큐에 쌓여도 차례로 배차.
- 비목표: 하드 강제(프로세스의 실제 할당량을 커널 레벨에서 제한하지 않음. advisory/협조적). 실행 중 작업의 선점/eviction 없음. 단일 GPU·단일 호스트·홈 규모.

## 아키텍처
- **데몬 `vramgated`**: 상주 프로세스. 예산 + 큐 소유. Unix 도메인 소켓 `${XDG_RUNTIME_DIR:-/run/user/$UID}/vramgate.sock`(설정 가능)에서 listen. **외부 의존성 0** (Node 내장 모듈만: `net`, `child_process`, `fs`).
- **프로토콜**: 소켓 위 NDJSON(줄바꿈 구분 JSON). request/response + 비동기 grant 이벤트. **연결 바인딩 리스**: 클라이언트 소켓이 닫히면(정상/크래시 무관) 그 연결의 모든 리스가 자동 해제된다(advisory file lock이 fd에 묶이는 것과 동일 원리).
- **클라이언트 라이브러리 `client.js`**: `new VramgateClient({socket})`, `acquire(mib, {priority,label,timeoutMs})`→grant 시 resolve되는 Promise, `lease.release()`, `status()`, 편의 `withLease(mib, opts, async fn)`.
- **CLI `bin/vramgate`**: `daemon` / `run` / `hold` / `status`.

## 핵심: Admission 규칙
설정값:
- `TOTAL_MIB`: 관리 예산. 기본 = nvidia-smi로 감지한 `memory.total` − `RESERVE_MIB`.
- `RESERVE_MIB`: 데스크탑/컴포지터/여유분 기본 1024.
- `SAFETY_MIB`: 추가 안전 마진 기본 512.
- `SMI_POLL_MS`: nvidia-smi 폴링 주기 기본 2000.
- `GPU_INDEX`: 기본 0.

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

**비선점**: 실행 중인 관리 작업도, 실행 중인 게임도 절대 죽이지 않는다. 브로커는 오직 **신규 admission만 게이트**한다. 게임을 보호하려면 사용자가 `hold`로 먼저 예약(아래).

## 큐 / 공정성
- 우선순위 정수 내림차순, 동순위는 FIFO. 기본 priority 0.
- release나 external 감소 등 예산 변동 시 큐를 앞에서부터 재스캔해 **들어갈 수 있는 것들을 순서대로 모두** admit.
- v1은 엄격한 priority-FIFO(head-of-line). 앞의 큰 작업이 안 들어가면 뒤의 작은 작업도 대기(예측 가능성 우선). 백필(backfill)은 향후 TODO로 README에 명시.

## 리스 생명주기
- grant → `{leaseId, mib}`. 연결 바인딩(소켓 close = 그 연결 모든 리스 release). 명시적 `release`. TTL/heartbeat는 v1 선택(연결 바인딩으로 충분, 옵션 설정만 남겨둠).

## CLI
- `vramgate daemon [--budget MIB] [--reserve MIB] [--safety MIB] [--socket PATH] [--gpu N] [--poll MS]` — 브로커 실행(systemd 유닛도 이걸 호출).
- `vramgate run --vram 8G [--priority N] [--label L] [--wait-timeout S] -- <cmd...>` — 리스 획득 후 cmd를 자식으로 spawn, cmd 종료 시 release. **cmd exit code 그대로 전파.** ComfyUI/게임/수동 실행 래퍼가 이것.
- `vramgate hold --vram 8G [--label gaming]` — 획득 후 SIGINT(Ctrl-C)까지 유지. 게임 스트리밍 등 인터랙티브 예약용. 획득되면 메시지 출력.
- `vramgate status [--json]` — 예산, live used/free/total, external, 활성 리스(id·label·mib), 대기 큐(cost·priority·나이) 표시.
- 단위 파싱: `8G`/`8192M`/`8192`(기본 MiB).

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
**failOpen(기본 true)**: 데몬 미기동/소켓 없음이면 리스 없이 그냥 진행(=현행 일반 VRAM 사용). failClosed면 throw. → 브로커가 꺼져 있어도 서비스가 정상 동작(서비스 연동의 "초기 off = 일반 사용" 요구를 이걸로 충족).

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
