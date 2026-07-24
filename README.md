# vramgate

*English · [한국어](README.ko.md)*

`vramgate` is a cooperative VRAM admission-control broker that reduces out-of-memory failures when several processes share a single NVIDIA GPU. It needs only Node.js 20+ and has no external package dependencies.

## Install and run

```sh
npm install
node bin/vramgate daemon
node bin/vramgate status
```

The default socket path is `${XDG_RUNTIME_DIR:-/run/user/$UID}/vramgate.sock`. To run it as a systemd user service, copy `systemd/vramgate.service` into a user unit path and start it with `systemctl --user enable --now vramgate`.

```sh
vramgate daemon --budget 15360 --reserve 1024 --safety 512 --idle-threshold 1536
vramgate run --vram 8G --label sdxl -- python worker.py
vramgate idle-run --vram 12G --idle 5m --stop-grace 30s --label train -- python train.py
vramgate hold --vram 8G --label gaming
vramgate status --json
```

- `run` — acquires a lease, runs the command, and forwards the child's exit code.
- `hold` — keeps the reservation until you press Ctrl-C.
- `idle-run` — runs a low-priority job while the GPU has been idle for the given window. When a regular request arrives, it sends SIGTERM to the child (then SIGKILL after 30s by default), releases the lease, waits for the GPU to go idle again, and restarts. If the child exits on its own, it exits with that code. Saving and resuming from checkpoints is the child program's responsibility.

## Node client

```js
import { VramBusyError, VramgateClient } from 'vramgate';

const client = new VramgateClient({ socket: process.env.VRAMGATE_SOCKET });
await client.withLease(8 * 1024, { label: 'sdxl', priority: 0 }, async () => {
  // GPU work
});

const training = await client.acquire(12 * 1024, {
  preemptible: true,
  idleWindowMs: 5 * 60_000
});
training.onPreempt(() => stopTraining());
await training.preempted; // can also await the Promise instead of the callback
```

The client exposes `acquire(mib, options)`, `status()`, and `withLease(mib, options, fn)`. If the connection itself fails, it returns a no-op lease according to the default `failOpen: true`. Once connected, queue waiting is indefinite when `timeoutMs` is unset or 0; a positive value throws `VramBusyError` on expiry instead of failing open. The same policy applies to `withLease`.

## Architecture

The daemon accepts requests over an NDJSON protocol on a Unix socket and manages a weighted counting semaphore. Higher-priority requests are served first, and requests at the same priority are served FIFO. Every lease obtained on a connection is released automatically when that connection closes.

External usage is defined as the measured `nvidia-smi` usage minus the active managed leases. A new request is admitted only when the sum of managed leases, external usage, the request cost, and the safety margin stays within the physical VRAM limit.

GPU queries reuse the last good measurement briefly, but after 3 consecutive failures (the default) new-lease admission is halted. Admission resumes automatically once a good measurement returns. The threshold can be changed with `--gpu-failure-limit` or `VRAMGATE_GPU_FAILURE_LIMIT`. At startup, before any good measurement has been obtained, admission is blocked immediately.

`busy` is true when there is a non-preemptible active lease or a queued request, or when external usage exceeds `--idle-threshold` (default 1536 MiB). A preemptible lease is admitted only when both the VRAM condition and the "idle for `idleWindowMs`" condition are met. If the system becomes busy afterward, the daemon only sends a `preempt` event to the client — it never terminates the process directly. `status` includes `busy`, `lastBusyAt`, `idleThreshold`, and the preemptible details of each lease and queue entry.

## Operational audit log

The daemon logs `queue`, `grant`, `release`, `cancel`, `preempt`, and GPU-query halt/recover events to standard output as one-line JSON prefixed with `vramgate:audit`. Under systemd you can query them with:

```sh
journalctl --user -u vramgate -g 'vramgate:audit'
```

Each lease log carries the label, MiB, priority, wait time, hold time, and release reason, so you can tally activity and bottlenecks after the fact.

## Manual ComfyUI / game-streaming use

Programs you launch directly, such as ComfyUI, can also be reserved through the wrapper.

```sh
vramgate run --vram 10G --label comfyui -- python main.py
vramgate run --vram 8G --label game-stream -- ./start-game.sh
```

If a game must be launched from a separate launcher, reserve the space first with `vramgate hold --vram 8G --label gaming` and release it with Ctrl-C after quitting. Even when a program is not wrapped by vramgate, its measured `nvidia-smi` usage counts as external, so pending managed jobs automatically steer around it. Note that vramgate is non-preemptive: it will not stop or reclaim VRAM from an already-running managed job or game.

## Custodian

Custodian registers the resident model VRAM that Ollama or ComfyUI holds while idle as a preemptible cache lease, then unloads the model to reclaim VRAM when another job needs the space. Enable the per-backend services with:

```sh
systemctl --user enable --now vramgate-custodian@ollama
systemctl --user enable --now vramgate-custodian@comfyui
```

## Roadmap

- Backfill remains deliberately deferred. Without bounded lease runtimes or enforceable
  preemption, admitting a smaller request behind a blocked head can delay that head and
  violate priority/FIFO. See `DESIGN.md` for the prerequisites of a safe implementation.

## Tests

```sh
npm test
```

MIT License, Copyright (c) 2026 banip.
