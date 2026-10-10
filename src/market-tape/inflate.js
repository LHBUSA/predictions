// Resumable DEFLATE (RFC 1951) decoder for the IEX HIST collector (issue #56). Pure JS, Workers + Node.
// Why: one IEX TOPS day is a single ~9 GB gzip member (~38 GB raw). Native DecompressionStream cannot be checkpointed and
// one full pass exceeds a Worker invocation's CPU cap, so the collector decodes in steps and checkpoints between steps AT
// DEFLATE BLOCK BOUNDARIES. A checkpoint is tiny and exact: { bit position in the compressed file, last 32 KiB of output,
// output total }. The next step range-requests the file from floor(bit/8) and resumes with the window as dictionary.
//
// API: const d = createInflater({ window, bitOffset, onOutput }); d.push(bytes) (compressed, starting at the checkpoint
// byte); d.atBoundary() / d.checkpoint(); d.done. gzip header/trailer: parseGzipHeader(bytes) -> header length.

const LBASE = new Uint16Array([3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]);
const LEXT = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]);
const DBASE = new Uint16Array([1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]);
const DEXT = new Uint8Array([0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]);
const CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
const WSIZE = 32768;

// Canonical Huffman -> flat lookup table indexed by the next `bits` input bits (LSB-first): entry = sym << 4 | codeLen.
function buildTable(lengths, n) {
  let max = 0;
  for (let i = 0; i < n; i++) if (lengths[i] > max) max = lengths[i];
  if (max === 0) return { table: new Uint16Array(2), bits: 1 };
  const count = new Uint16Array(16);
  for (let i = 0; i < n; i++) count[lengths[i]]++;
  count[0] = 0;
  const next = new Uint16Array(16);
  let code = 0;
  for (let b = 1; b <= max; b++) { code = (code + count[b - 1]) << 1; next[b] = code; }
  const size = 1 << max;
  const table = new Uint16Array(size);
  for (let s = 0; s < n; s++) {
    const len = lengths[s];
    if (!len) continue;
    let c = next[len]++;
    // reverse `len` bits (deflate codes are stored MSB-first in an LSB-first stream)
    let r = 0;
    for (let i = 0; i < len; i++) { r = (r << 1) | (c & 1); c >>= 1; }
    const entry = (s << 4) | len;
    for (let j = r; j < size; j += 1 << len) table[j] = entry;
  }
  return { table, bits: max };
}
let FIXED = null;
function fixedTables() {
  if (FIXED) return FIXED;
  const l = new Uint8Array(288);
  for (let i = 0; i < 144; i++) l[i] = 8; for (let i = 144; i < 256; i++) l[i] = 9; for (let i = 256; i < 280; i++) l[i] = 7; for (let i = 280; i < 288; i++) l[i] = 8;
  const d = new Uint8Array(30).fill(5);
  FIXED = { lit: buildTable(l, 288), dist: buildTable(d, 30) };
  return FIXED;
}

export function parseGzipHeader(b) {
  if (b[0] !== 0x1f || b[1] !== 0x8b || b[2] !== 8) throw new Error('inflate: not a gzip/deflate stream');
  const flg = b[3];
  let o = 10;
  if (flg & 4) o += 2 + (b[o] | (b[o + 1] << 8));
  if (flg & 8) { while (b[o] !== 0) o++; o++; }
  if (flg & 16) { while (b[o] !== 0) o++; o++; }
  if (flg & 2) o += 2;
  return o;
}

// Decoder over a growing input buffer. Output goes to onOutput(Uint8Array) in chunks; the last 32 KiB are kept as window.
// State machine runs whole blocks only when enough input is buffered (`need` guards); it never splits a symbol across pushes.
export function createInflater({ window = null, bitOffset = 0, onOutput, outChunk = 1 << 20 } = {}) {
  // output ring: [window (32 KiB history)] + current chunk
  let out = new Uint8Array(WSIZE + outChunk);
  let op = 0;
  if (window && window.length) { out.set(window.subarray(Math.max(0, window.length - WSIZE)), 0); op = Math.min(window.length, WSIZE); }
  let flushedTo = op; // bytes before this index were already emitted (the dictionary is never re-emitted)
  let inp = new Uint8Array(0), ip = 0;
  let bitBuf = 0, bitCnt = 0;
  let total = 0;
  let done = false, inBlock = false, last = false, stored = 0;
  let lit = null, dist = null;
  // initial bit alignment inside the first byte
  let skip = bitOffset & 7;

  function emit() {
    if (op > flushedTo) { onOutput(out.subarray(flushedTo, op)); total += op - flushedTo; flushedTo = op; }
    if (op > WSIZE + outChunk - 300) { // slide: keep the last 32 KiB
      out.copyWithin(0, op - WSIZE, op); op = WSIZE; flushedTo = WSIZE;
    }
  }
  const avail = () => (inp.length - ip) * 8 + bitCnt;
  function need(n) { while (bitCnt < n) { if (ip >= inp.length) return false; bitBuf |= inp[ip++] << bitCnt; bitCnt += 8; } return true; }
  function bits(n) { const v = bitBuf & ((1 << n) - 1); bitBuf >>>= n; bitCnt -= n; return v; }
  function decodeSym(t) {
    // assumes need(t.bits) satisfied or at least the code's length available
    const e = t.table[bitBuf & ((1 << t.bits) - 1)];
    const len = e & 15;
    if (len === 0 || len > bitCnt) return -1;
    bitBuf >>>= len; bitCnt -= len;
    return e >> 4;
  }

  // Header of a new block; returns false when more input is needed (state untouched).
  function blockHeader() {
    const save = { ip, bitBuf, bitCnt };
    const fail = () => { ip = save.ip; bitBuf = save.bitBuf; bitCnt = save.bitCnt; return false; };
    if (!need(3)) return fail();
    last = bits(1) === 1;
    const type = bits(2);
    if (type === 0) {
      bits(bitCnt & 7); // align to byte
      if (!need(32)) return fail();
      const len = bits(16), nlen = bits(16);
      if ((len ^ 0xffff) !== nlen) throw new Error('inflate: corrupt stored block');
      stored = len; lit = null; inBlock = true; return true;
    }
    if (type === 1) { const f = fixedTables(); lit = f.lit; dist = f.dist; inBlock = true; return true; }
    if (type !== 2) throw new Error('inflate: invalid block type');
    if (!need(14)) return fail();
    const hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
    const cl = new Uint8Array(19);
    for (let i = 0; i < hclen; i++) { if (!need(3)) return fail(); cl[CLORDER[i]] = bits(3); }
    const clt = buildTable(cl, 19);
    const lens = new Uint8Array(hlit + hdist);
    for (let i = 0; i < hlit + hdist;) {
      if (!need(clt.bits) && avail() < 1) return fail();
      need(clt.bits);
      const s = decodeSym(clt);
      if (s < 0) return fail();
      if (s < 16) lens[i++] = s;
      else if (s === 16) { if (!need(2)) return fail(); const r = 3 + bits(2); const p = lens[i - 1]; for (let k = 0; k < r; k++) lens[i++] = p; }
      else if (s === 17) { if (!need(3)) return fail(); i += 3 + bits(3); }
      else { if (!need(7)) return fail(); i += 11 + bits(7); }
    }
    lit = buildTable(lens.subarray(0, hlit), hlit);
    dist = buildTable(lens.subarray(hlit), hdist);
    inBlock = true;
    return true;
  }

  // Decode inside the current block; returns 'end' at end-of-block, 'more' when input ran short (state consistent).
  function blockBody() {
    if (!lit) { // stored
      while (stored > 0) {
        if (bitCnt >= 8) { out[op++] = bits(8); stored--; }
        else if (ip < inp.length) { out[op++] = inp[ip++]; stored--; }
        else return 'more';
        if (op > WSIZE + outChunk - 300) emit();
      }
      return 'end';
    }
    const lt = lit.table, lb = lit.bits, lm = (1 << lb) - 1, dt = dist.table, db = dist.bits, dm = (1 << db) - 1;
    for (;;) {
      // worst case one symbol: 15 (lit) + 5 (ext) + 15 (dist) + 13 (ext) = 48 bits -> require 48 available or bail
      if (bitCnt < 48) { while (bitCnt <= 24 && ip < inp.length) { bitBuf |= inp[ip++] << bitCnt; bitCnt += 8; } }
      const save0 = ip, sb = bitBuf, sc = bitCnt;
      // literal/length
      if (bitCnt < lb && ip >= inp.length) { const e = lt[bitBuf & lm]; if ((e & 15) === 0 || (e & 15) > bitCnt) return 'more'; }
      let e = lt[bitBuf & lm]; let len = e & 15;
      if (len === 0) throw new Error('inflate: invalid code');
      if (len > bitCnt) return 'more';
      bitBuf >>>= len; bitCnt -= len;
      const sym = e >> 4;
      if (sym < 256) { out[op++] = sym; if (op > WSIZE + outChunk - 300) emit(); continue; }
      if (sym === 256) return 'end';
      const li = sym - 257;
      if (li >= 29) throw new Error('inflate: invalid length symbol');
      // need extra bits + distance code + distance extra bits; refill (bitCnt <= 24 guarantee before the 2nd refill)
      while (bitCnt <= 24 && ip < inp.length) { bitBuf |= inp[ip++] << bitCnt; bitCnt += 8; }
      const le = LEXT[li];
      if (bitCnt < le) { ip = save0; bitBuf = sb; bitCnt = sc; return 'more'; }
      const length = LBASE[li] + (le ? (bitBuf & ((1 << le) - 1)) : 0);
      bitBuf >>>= le; bitCnt -= le;
      while (bitCnt <= 24 && ip < inp.length) { bitBuf |= inp[ip++] << bitCnt; bitCnt += 8; }
      e = dt[bitBuf & dm]; len = e & 15;
      if (len === 0 || len > bitCnt) { if (len === 0 && bitCnt >= db) throw new Error('inflate: invalid distance code'); ip = save0; bitBuf = sb; bitCnt = sc; return 'more'; }
      bitBuf >>>= len; bitCnt -= len;
      const ds = e >> 4;
      if (ds >= 30) throw new Error('inflate: invalid distance symbol');
      const de = DEXT[ds];
      while (bitCnt <= 24 && ip < inp.length) { bitBuf |= inp[ip++] << bitCnt; bitCnt += 8; }
      if (bitCnt < de) { ip = save0; bitBuf = sb; bitCnt = sc; return 'more'; }
      const d = DBASE[ds] + (de ? (bitBuf & ((1 << de) - 1)) : 0);
      bitBuf >>>= de; bitCnt -= de;
      if (d > op) throw new Error('inflate: distance beyond window');
      let from = op - d;
      for (let k = 0; k < length; k++) out[op++] = out[from++];
      if (op > WSIZE + outChunk - 300) emit();
    }
  }

  function run() {
    while (!done) {
      if (!inBlock) { if (!blockHeader()) return; }
      const r = blockBody();
      if (r === 'more') return;
      inBlock = false;
      if (last) { done = true; emit(); return; }
      if (stopRequested) { emit(); return; }
    }
  }

  let stopRequested = false;
  return {
    push(chunk) {
      if (done) return;
      // drop consumed input, append new
      const rest = inp.subarray(ip);
      const n = new Uint8Array(rest.length + chunk.length); n.set(rest); n.set(chunk, rest.length); inp = n; ip = 0;
      if (skip) { if (!need(skip)) return; bits(skip); skip = 0; }
      run();
      emit();
    },
    // ask the decoder to pause at the next block boundary (returns true once paused there)
    requestStop() { stopRequested = true; },
    get atBoundary() { return !inBlock; },
    get done() { return done; },
    get totalOut() { return total; },
    // exact resume point: absolute bit offset = baseBit + consumed bits. Only valid atBoundary.
    consumedBits() { return (ip * 8) - bitCnt; },
    window() { return out.slice(Math.max(0, op - WSIZE), op); },
  };
}
