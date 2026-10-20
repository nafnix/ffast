// SHA-256 fallback for self-hosted HTTP origins where Web Crypto is unavailable.
const primes: number[] = [];
for (let value = 2; primes.length < 64; value++) {
  if (!primes.some(p => p * p <= value && value % p === 0)) primes.push(value);
}
const constants = primes.map(p => (Math.cbrt(p) % 1 * 2 ** 32) >>> 0);
const initial = primes.slice(0, 8).map(p => (Math.sqrt(p) % 1 * 2 ** 32) >>> 0);
const rotate = (v: number, n: number) => (v >>> n) | (v << (32 - n));
export async function chunkHash(buffer: ArrayBuffer, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    signal?.throwIfAborted();
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
  }
  const input = new Uint8Array(buffer);
  const padded = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64);
  padded.set(input);
  padded[input.length] = 128;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(input.length / 2 ** 29));
  view.setUint32(padded.length - 4, (input.length * 8) >>> 0);
  const state = initial.slice();
  const words = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    // Yield periodically so pause/cancel remains responsive during fallback hashing.
    if (offset % (256 * 1024) === 0) { await new Promise(resolve => setTimeout(resolve, 0)); signal?.throwIfAborted(); }
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = words[i - 15], y = words[i - 2];
      words[i] = words[i - 16] + (rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3)) + words[i - 7] + (rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10));
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + constants[i] + words[i]) | 0;
      const t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    [a, b, c, d, e, f, g, h].forEach((v, i) => { state[i] = (state[i] + v) >>> 0; });
  }
  return state.map(v => v.toString(16).padStart(8, "0")).join("");
}
