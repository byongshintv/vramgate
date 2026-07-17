export function parseMib(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
      throw new TypeError(`invalid MiB value: ${value}`);
    }
    return value;
  }
  if (typeof value !== 'string') throw new TypeError('memory size must be a number or string');
  const match = value.trim().match(/^(\d+)\s*([gGmM])?$/);
  if (!match) throw new TypeError(`invalid memory size: ${value}`);
  const amount = Number(match[1]);
  const mib = match[2]?.toLowerCase() === 'g' ? amount * 1024 : amount;
  if (!Number.isSafeInteger(mib)) throw new RangeError(`memory size is too large: ${value}`);
  return mib;
}

export const parseMemory = parseMib;
