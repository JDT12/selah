// Selah: pdf.js 6 uses JavaScript added in 2025-26 (Map.getOrInsertComputed, Math.sumPrecise, Uint8Array.toHex…).
// A browser a few versions behind shows the reader's toolbar but never the document, so the missing pieces are
// added here: viewer.html loads this before pdf.mjs, and pdf.worker.compat.mjs loads it before the worker.
const def = (o, k, f) => { if (!o[k]) Object.defineProperty(o, k, { value: f, writable: true, configurable: true }); };
for (const M of [Map, WeakMap]) {
  def(M.prototype, 'getOrInsert', function getOrInsert(k, v) { if (!this.has(k)) this.set(k, v); return this.get(k); });
  def(M.prototype, 'getOrInsertComputed', function getOrInsertComputed(k, f) { if (!this.has(k)) this.set(k, f(k)); return this.get(k); });
}
def(Uint8Array.prototype, 'toHex', function toHex() { return Array.from(this, (b) => b.toString(16).padStart(2, '0')).join(''); });
def(Math, 'sumPrecise', (list) => { let sum = 0; for (const n of list) sum += n; return sum; });
def(Promise, 'try', (f, ...args) => new Promise((resolve) => { resolve(f(...args)); }));
