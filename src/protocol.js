export function encodeMessage(message) {
  return `${JSON.stringify(message)}\n`;
}

export function createDecoder(onMessage, onError = () => {}) {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk.toString('utf8');
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          onMessage(JSON.parse(line));
        } catch (error) {
          onError(error, line);
        }
      }
    },
    get buffer() {
      return buffer;
    }
  };
}

export const createNdjsonDecoder = createDecoder;
