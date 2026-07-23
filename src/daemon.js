import net from 'node:net';
import { unlink } from 'node:fs/promises';
import { createGpuQuery } from './gpu.js';
import { createDecoder, encodeMessage } from './protocol.js';

export function defaultSocketPath(env = process.env) {
  return `${env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 0}`}/vramgate.sock`;
}

export class VramgateDaemon {
  constructor(options = {}) {
    this.socket = options.socket ?? defaultSocketPath();
    this.reserve = Number(options.reserve ?? options.reserveMib ?? 1024);
    this.safety = Number(options.safety ?? options.safetyMib ?? 512);
    this.pollMs = Number(options.poll ?? options.pollMs ?? 2000);
    this.gpuFailureLimit = Math.max(1, Number(options.gpuFailureLimit ?? 3));
    this.idleThreshold = Number(options.idleThreshold ?? options.idleThresholdMib ?? 1536);
    this.budget = options.budget == null ? null : Number(options.budget);
    this.live = { used: 0, total: this.budget == null ? 0 : this.budget + this.reserve };
    this.queryGpu = createGpuQuery({
      index: Number(options.gpu ?? options.gpuIndex ?? 0),
      queryFn: options.queryFn,
      totalMib: this.live.total,
      logger: options.logger
    });
    this.leases = new Map();
    this.queue = [];
    this.sequence = 0;
    this.leaseSequence = 0;
    this.server = null;
    this.timer = null;
    this.connections = new Set();
    this.lastBusyAt = Date.now();
    this.preemptNotified = new Set();
    this.logger = options.logger === undefined ? console : options.logger;
    this.connectionSequence = 0;
    this.admissionBlocked = false;
  }

  get granted() {
    let value = 0;
    for (const lease of this.leases.values()) value += lease.mib;
    return value;
  }

  get external() {
    return Math.max(0, this.live.used - this.granted);
  }

  get physicalLimit() {
    return this.budget == null ? this.live.total : this.budget + this.reserve;
  }

  audit(event, fields = {}) {
    this.logger?.info?.(`vramgate:audit ${JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...fields
    })}`);
  }

  get busy() {
    return [...this.leases.values()].some(lease => !lease.preemptible)
      || this.queue.some(item => !item.preemptible)
      || this.external > this.idleThreshold;
  }

  updateBusy(now = Date.now()) {
    if (this.busy) {
      this.lastBusyAt = now;
      for (const lease of this.leases.values()) {
        if (lease.preemptible && !this.preemptNotified.has(lease.leaseId)) {
          this.preemptNotified.add(lease.leaseId);
          this.audit('preempt', {
            leaseId: lease.leaseId, mib: lease.mib, label: lease.label,
            reason: 'firm-demand'
          });
          this.send(lease.connection.socket, { type: 'preempt', leaseId: lease.leaseId });
        }
      }
    }
  }

  async start() {
    if (this.server) return this;
    await this.poll();
    if (this.budget == null) this.budget = Math.max(0, this.live.total - this.reserve);
    await unlink(this.socket).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    this.server = net.createServer(socket => this.handleConnection(socket));
    await new Promise((resolve, reject) => {
      const onError = error => reject(error);
      this.server.once('error', onError);
      this.server.listen(this.socket, () => {
        this.server.off('error', onError);
        resolve();
      });
    });
    this.timer = setInterval(() => void this.poll(), this.pollMs);
    this.timer.unref?.();
    return this;
  }

  async poll() {
    const wasBlocked = this.admissionBlocked;
    this.live = await this.queryGpu();
    this.admissionBlocked = !this.live.hasSuccessfulReading
      || (!this.live.queryHealthy && this.live.consecutiveFailures >= this.gpuFailureLimit);
    if (!wasBlocked && this.admissionBlocked) {
      this.audit('gpu-admission-blocked', {
        consecutiveFailures: this.live.consecutiveFailures,
        hasSuccessfulReading: this.live.hasSuccessfulReading
      });
    } else if (wasBlocked && !this.admissionBlocked && this.live.queryHealthy) {
      this.audit('gpu-query-recovered');
    }
    this.updateBusy();
    this.scanQueue();
    return this.live;
  }

  handleConnection(socket) {
    this.connections.add(socket);
    socket.setEncoding('utf8');
    const state = {
      socket, leaseIds: new Set(), pending: new Set(), closed: false,
      connectionId: ++this.connectionSequence
    };
    const decoder = createDecoder(
      message => this.handleMessage(state, message),
      error => this.send(socket, { type: 'error', error: `invalid JSON: ${error.message}` })
    );
    socket.on('data', chunk => decoder.push(chunk));
    const cleanup = () => {
      if (state.closed) return;
      state.closed = true;
      this.connections.delete(socket);
      this.queue = this.queue.filter(item => item.connection !== state);
      for (const leaseId of state.leaseIds) {
        const lease = this.leases.get(leaseId);
        this.leases.delete(leaseId);
        if (lease) {
          this.audit('release', {
            leaseId, mib: lease.mib, label: lease.label,
            reason: 'connection-close', heldMs: Date.now() - lease.grantedAt
          });
        }
      }
      this.updateBusy();
      this.scanQueue();
    };
    socket.on('close', cleanup);
    socket.on('error', () => {});
  }

  handleMessage(connection, message) {
    const requestId = message.requestId ?? message.id;
    if (message.type === 'acquire') {
      const mib = Number(message.mib);
      if (!Number.isInteger(mib) || mib <= 0) {
        return this.send(connection.socket, { type: 'error', requestId, error: 'mib must be a positive integer' });
      }
      const item = {
        requestId, mib,
        preemptible: message.preemptible === true,
        adopt: message.adopt === true,
        idleWindowMs: Math.max(0, Number(message.idleWindowMs) || 0),
        priority: Number.isInteger(message.priority) ? message.priority : (message.preemptible === true ? -100 : 0),
        label: String(message.label ?? ''),
        enqueuedAt: Date.now(),
        sequence: this.sequence++,
        connection
      };
      if (item.adopt) {
        const leaseId = `${process.pid}-${Date.now().toString(36)}-${(++this.leaseSequence).toString(36)}`;
        const lease = {
          leaseId, mib: item.mib, label: item.label, priority: item.priority,
          preemptible: item.preemptible, adopt: true, grantedAt: Date.now(), connection
        };
        this.leases.set(leaseId, lease);
        connection.leaseIds.add(leaseId);
        this.audit('grant', {
          leaseId, mib: item.mib, label: item.label, priority: item.priority,
          preemptible: item.preemptible, adopt: true, waitMs: 0
        });
        this.send(connection.socket, {
          type: 'grant', requestId, leaseId, mib: item.mib,
          preemptible: item.preemptible
        });
        this.updateBusy();
        this.scanQueue();
        return;
      }
      this.queue.push(item);
      this.queue.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
      connection.pending.add(requestId);
      this.audit('queue', {
        mib: item.mib, label: item.label, priority: item.priority,
        preemptible: item.preemptible,
        reason: this.admissionBlocked ? 'gpu-query-unhealthy' : 'capacity-or-idle'
      });
      this.updateBusy();
      this.scanQueue();
      return;
    }
    if (message.type === 'release') {
      const lease = this.leases.get(message.leaseId);
      if (lease?.connection === connection) {
        this.leases.delete(message.leaseId);
        this.preemptNotified.delete(message.leaseId);
        connection.leaseIds.delete(message.leaseId);
        this.audit('release', {
          leaseId: message.leaseId, mib: lease.mib, label: lease.label,
          reason: 'client', heldMs: Date.now() - lease.grantedAt
        });
      }
      this.send(connection.socket, { type: 'released', requestId, leaseId: message.leaseId });
      this.updateBusy();
      this.scanQueue();
      return;
    }
    if (message.type === 'cancel') {
      const cancelled = this.queue.find(
        item => item.connection === connection && item.requestId === message.targetRequestId
      );
      this.queue = this.queue.filter(item => !(item.connection === connection && item.requestId === message.targetRequestId));
      connection.pending.delete(message.targetRequestId);
      if (cancelled) {
        this.audit('cancel', {
          mib: cancelled.mib, label: cancelled.label,
          waitMs: Date.now() - cancelled.enqueuedAt
        });
      }
      this.send(connection.socket, { type: 'cancelled', requestId });
      this.updateBusy();
      this.scanQueue();
      return;
    }
    if (message.type === 'status') {
      this.send(connection.socket, { type: 'status', requestId, ...this.status() });
      return;
    }
    this.send(connection.socket, { type: 'error', requestId, error: `unknown request type: ${message.type}` });
  }

  scanQueue() {
    this.updateBusy();
    if (this.admissionBlocked) return;
    while (this.queue.length) {
      const item = this.queue[0];
      if (item.connection.closed) {
        this.queue.shift();
        continue;
      }
      if (this.granted + this.external + item.mib + this.safety > this.physicalLimit) break;
      if (item.preemptible && Date.now() - this.lastBusyAt < item.idleWindowMs) break;
      this.queue.shift();
      item.connection.pending.delete(item.requestId);
      const leaseId = `${process.pid}-${Date.now().toString(36)}-${(++this.leaseSequence).toString(36)}`;
      const lease = {
        leaseId, mib: item.mib, label: item.label, priority: item.priority,
        preemptible: item.preemptible, grantedAt: Date.now(), connection: item.connection
      };
      this.leases.set(leaseId, lease);
      item.connection.leaseIds.add(leaseId);
      this.audit('grant', {
        leaseId, mib: item.mib, label: item.label, priority: item.priority,
        preemptible: item.preemptible, adopt: false,
        waitMs: Date.now() - item.enqueuedAt
      });
      this.send(item.connection.socket, {
        type: 'grant', requestId: item.requestId, leaseId, mib: item.mib,
        preemptible: item.preemptible
      });
    }
  }

  status() {
    return {
      budget: this.budget,
      reserve: this.reserve,
      safety: this.safety,
      live: { ...this.live, free: Math.max(0, this.live.total - this.live.used) },
      granted: this.granted,
      external: this.external,
      busy: this.busy,
      lastBusyAt: this.lastBusyAt,
      idleThreshold: this.idleThreshold,
      gpuQueryHealthy: this.live.queryHealthy,
      gpuQueryFailures: this.live.consecutiveFailures,
      admissionBlocked: this.admissionBlocked,
      leases: [...this.leases.values()].map(({ connection, ...lease }) => lease),
      queue: this.queue.map(item => ({
        mib: item.mib, priority: item.priority, label: item.label,
        preemptible: item.preemptible, idleWindowMs: item.idleWindowMs,
        ageMs: Date.now() - item.enqueuedAt
      }))
    };
  }

  send(socket, message) {
    if (!socket.destroyed) socket.write(encodeMessage(message));
  }

  async close() {
    clearInterval(this.timer);
    this.timer = null;
    for (const socket of this.connections) socket.destroy();
    if (this.server) {
      await new Promise(resolve => this.server.close(resolve));
      this.server = null;
    }
    await unlink(this.socket).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

export async function createDaemon(options = {}) {
  const daemon = new VramgateDaemon(options);
  await daemon.start();
  return daemon;
}
