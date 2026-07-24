import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { VramgateClient } from './client.js';

const execFileAsync = promisify(execFile);
const MIB = 1024 * 1024;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function endpoint(base, path) {
  return new URL(path, base.endsWith('/') ? base : `${base}/`);
}

export async function fetchWithRetry(url, init, {
  retries = 3,
  backoffMs = 300,
  logger
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, init);
      if (!response.ok) throw new Error(`HTTP request returned ${response.status}`);
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        logger?.warn?.('[custodian]', `request failed; retrying (${attempt}/${retries})`);
        await sleep(backoffMs * attempt);
      }
    }
  }
  logger?.error?.('[custodian]', lastError.message);
  throw lastError;
}

async function withRetry(operation, { retries = 3, backoffMs = 300, logger } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        logger?.warn?.('[custodian]', `command failed; retrying (${attempt}/${retries})`);
        await sleep(backoffMs * attempt);
      }
    }
  }
  logger?.error?.('[custodian]', lastError.message);
  throw lastError;
}

async function ollamaModels(baseUrl, options) {
  const response = await fetchWithRetry(endpoint(baseUrl, 'api/ps'), undefined, options);
  return (await response.json()).models ?? [];
}

function createOllamaBackend({ logger = console } = {}) {
  const baseUrl = process.env.VRAMGATE_OLLAMA_URL ?? 'http://127.0.0.1:11434';
  const retries = positiveInteger(process.env.VRAMGATE_OLLAMA_FETCH_RETRIES, 3);
  const configuredLabels = process.env.VRAMGATE_OLLAMA_LABELS;
  const labels = configuredLabels === undefined
    ? ['llm', 'vlm']
    : configuredLabels.split(',').map(label => label.trim()).filter(Boolean);
  return {
    sameBackendLabels: new Set(labels),
    async shouldUnload(status) {
      const demand = [...status.leases, ...status.queue]
        .filter(item => item.preemptible === false)
        .map(item => item.label)
        .filter(label => label.startsWith('ollama:model:'));
      if (!demand.length) return !hasActiveSameBackend(status, this.sameBackendLabels);
      const resident = await ollamaModels(baseUrl, { retries, logger });
      const residentNames = new Set(resident.flatMap(model => {
        const name = model.name ?? model.model ?? '';
        return [name, name.replace(/:latest$/, '')];
      }));
      return demand.some(label => {
        const requested = label.slice('ollama:model:'.length);
        return !residentNames.has(requested) && !residentNames.has(requested.replace(/:latest$/, ''));
      });
    },
    async queryResidentMib() {
      const models = await ollamaModels(baseUrl, { retries, logger });
      return Math.round(models.reduce((sum, model) => sum + Number(model.size_vram || 0), 0) / MIB);
    },
    async unload() {
      let models;
      try {
        models = await ollamaModels(baseUrl, { retries, logger });
      } catch (error) {
        return;
      }
      for (const model of models) {
        try {
          const response = await fetch(endpoint(baseUrl, 'api/generate'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            signal: AbortSignal.timeout(10000),
            body: JSON.stringify({ model: model.name ?? model.model, prompt: '', keep_alive: 0 })
          });
          if (!response.ok) throw new Error(`Ollama unload returned ${response.status}`);
        } catch (error) {
          logger.error?.('[custodian]', error.message);
        }
      }
    }
  };
}

function createComfyuiBackend({ logger = console } = {}) {
  const baseUrl = process.env.VRAMGATE_COMFYUI_URL ?? 'http://127.0.0.1:8188';
  const processMatch = new RegExp(process.env.VRAMGATE_COMFYUI_PROC_MATCH ?? 'ComfyUI');
  return {
    sameBackendLabels: new Set(['sdxl']),
    async queryResidentMib() {
      const { stdout } = await withRetry(() => execFileAsync('nvidia-smi', [
          '--query-compute-apps=pid,used_gpu_memory',
          '--format=csv,noheader,nounits'
        ]), { retries: 3, logger });
      let total = 0;
      for (const line of stdout.split('\n')) {
        const match = line.match(/^\s*(\d+)\s*,\s*(\d+(?:\.\d+)?)\s*$/);
        if (!match) continue;
        try {
          const cmdline = (await readFile(`/proc/${match[1]}/cmdline`, 'utf8')).replaceAll('\0', ' ');
          if (processMatch.test(cmdline)) total += Number(match[2]);
          processMatch.lastIndex = 0;
        } catch {
          // The process may exit between nvidia-smi and reading /proc.
        }
      }
      return Math.round(total);
    },
    async unload() {
      const response = await fetch(endpoint(baseUrl, 'free'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ unload_models: true, free_memory: true })
      });
      if (!response.ok) throw new Error(`ComfyUI /free returned ${response.status}`);
    }
  };
}

export const BACKENDS = Object.freeze({
  ollama: createOllamaBackend,
  comfyui: createComfyuiBackend
});

export function hasActiveSameBackend(status, labels) {
  const matches = item => item.preemptible === false && (
    labels.has(item.label)
    || (labels.has('llm') && item.label.startsWith('ollama:model:'))
  );
  return status.leases.some(matches) || status.queue.some(matches);
}

export function createCustodian({
  backend,
  socket,
  minMib = 300,
  priority = -1000,
  confirmations = positiveInteger(process.env.VRAMGATE_RELEASE_CONFIRMATIONS, 2),
  logger = console
}) {
  const adapter = typeof backend === 'string'
    ? BACKENDS[backend]?.({ logger })
    : backend;
  if (!adapter) throw new Error(`unsupported custodian backend: ${backend}`);
  const backendName = typeof backend === 'string' ? backend : adapter.name;
  const cacheLabel = backendName ? `cache:${backendName}` : 'cache:custom';

  const client = new VramgateClient({ socket, failOpen: false });
  let lease = null;
  let evicting = false;
  let belowCount = 0;

  async function onPreempt() {
    if (!lease || evicting) return;
    evicting = true;
    const current = lease;
    lease = null;
    try {
      const status = await client.status();
      const shouldUnload = adapter.shouldUnload
        ? await adapter.shouldUnload(status)
        : !hasActiveSameBackend(status, adapter.sameBackendLabels);
      if (shouldUnload) await adapter.unload();
    } finally {
      await current.release();
      evicting = false;
    }
  }

  async function ensureLease() {
    if (lease || evicting) return;
    const resident = await adapter.queryResidentMib();
    if (resident < minMib) return;
    const status = await client.status();
    if (hasActiveSameBackend(status, adapter.sameBackendLabels)) {
      // A backend request may already be queued behind an incompatible resident
      // model before the custodian has acquired its cache lease. In that case
      // there is no lease to preempt, so proactively evict the stale resident.
      if (adapter.shouldUnload && await adapter.shouldUnload(status)) {
        await adapter.unload();
      }
      return;
    }
    lease = await client.acquire(resident, {
      preemptible: true,
      adopt: true,
      priority,
      label: cacheLabel,
      idleWindowMs: 0
    });
    lease.onPreempt(() => void onPreempt().catch(error => {
      logger.error?.('[custodian]', error.message);
    }));
    belowCount = 0;
  }

  async function tick() {
    await ensureLease();
    if (lease) {
      const resident = await adapter.queryResidentMib();
      if (resident < minMib) {
        belowCount++;
        if (belowCount >= confirmations) {
          const current = lease;
          lease = null;
          belowCount = 0;
          await current.release();
        }
      } else {
        belowCount = 0;
      }
    }
  }

  return {
    client,
    ensureLease,
    onPreempt,
    tick,
    get lease() { return lease; },
    get evicting() { return evicting; }
  };
}

export async function runCustodian({
  backend,
  socket,
  pollMs = 3000,
  minMib = 300,
  priority = -1000,
  confirmations = positiveInteger(process.env.VRAMGATE_RELEASE_CONFIRMATIONS, 2),
  logger = console
}) {
  const custodian = createCustodian({ backend, socket, minMib, priority, confirmations, logger });
  for (;;) {
    try {
      await custodian.tick();
    } catch (error) {
      logger.error?.('[custodian]', error.message);
    }
    await sleep(pollMs);
  }
}
