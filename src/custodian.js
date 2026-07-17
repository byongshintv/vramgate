import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { VramgateClient } from './client.js';

const execFileAsync = promisify(execFile);
const MIB = 1024 * 1024;

function endpoint(base, path) {
  return new URL(path, base.endsWith('/') ? base : `${base}/`);
}

async function ollamaModels(baseUrl) {
  const response = await fetch(endpoint(baseUrl, 'api/ps'));
  if (!response.ok) throw new Error(`Ollama /api/ps returned ${response.status}`);
  return (await response.json()).models ?? [];
}

function createOllamaBackend({ logger = console } = {}) {
  const baseUrl = process.env.VRAMGATE_OLLAMA_URL ?? 'http://127.0.0.1:11434';
  return {
    sameBackendLabels: new Set(['llm']),
    async queryResidentMib() {
      const models = await ollamaModels(baseUrl);
      return Math.round(models.reduce((sum, model) => sum + Number(model.size_vram || 0), 0) / MIB);
    },
    async unload() {
      let models;
      try {
        models = await ollamaModels(baseUrl);
      } catch (error) {
        logger.error?.('[custodian]', error.message);
        return;
      }
      for (const model of models) {
        try {
          const response = await fetch(endpoint(baseUrl, 'api/generate'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
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

function createComfyuiBackend() {
  const baseUrl = process.env.VRAMGATE_COMFYUI_URL ?? 'http://127.0.0.1:8188';
  const processMatch = new RegExp(process.env.VRAMGATE_COMFYUI_PROC_MATCH ?? 'ComfyUI');
  return {
    sameBackendLabels: new Set(['sdxl']),
    async queryResidentMib() {
      const { stdout } = await execFileAsync('nvidia-smi', [
        '--query-compute-apps=pid,used_gpu_memory',
        '--format=csv,noheader,nounits'
      ]);
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
  const matches = item => item.preemptible === false && labels.has(item.label);
  return status.leases.some(matches) || status.queue.some(matches);
}

export function createCustodian({
  backend,
  socket,
  minMib = 300,
  priority = -1000,
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

  async function onPreempt() {
    if (!lease || evicting) return;
    evicting = true;
    const current = lease;
    lease = null;
    try {
      const status = await client.status();
      const yieldToSameBackend = hasActiveSameBackend(status, adapter.sameBackendLabels);
      if (!yieldToSameBackend) await adapter.unload();
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
    if (hasActiveSameBackend(status, adapter.sameBackendLabels)) return;
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
  }

  async function tick() {
    await ensureLease();
    if (lease) {
      const resident = await adapter.queryResidentMib();
      if (resident < minMib) {
        const current = lease;
        lease = null;
        await current.release();
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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function runCustodian({
  backend,
  socket,
  pollMs = 3000,
  minMib = 300,
  priority = -1000,
  logger = console
}) {
  const custodian = createCustodian({ backend, socket, minMib, priority, logger });
  for (;;) {
    try {
      await custodian.tick();
    } catch (error) {
      logger.error?.('[custodian]', error.message);
    }
    await sleep(pollMs);
  }
}
