// External time anchor (proposed Amendment B3, V7): an RFC 3161 timestamp token over the ledger chain head after each
// sealed tick, from free public Time-Stamping Authorities (no account). A TSA cannot issue a token with a past genTime,
// so a token proves the chain head (and therefore every evidence hash sealed before it) existed by genTime, independent
// of Cloudflare and of anyone with Cloudflare admin rights. Full cryptographic verification is offline
// (`openssl ts -verify`); in the Worker we check status = granted, that the token echoes our hash, and read genTime.
export const TSAS = ['http://timestamp.digicert.com', 'http://timestamp.sectigo.com'];

const SHA256_ALGID = [0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00];
const fromHex = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));

// TimeStampReq ::= SEQUENCE { version 1, messageImprint { sha256, hash }, certReq TRUE }
export function timeStampRequest(hashHex) {
  const hash = fromHex(hashHex);
  if (hash.length !== 32) throw new Error('sha256 hash required');
  const imprint = [0x30, SHA256_ALGID.length + 34, ...SHA256_ALGID, 0x04, 0x20, ...hash];
  const body = [0x02, 0x01, 0x01, ...imprint, 0x01, 0x01, 0xff];
  return Uint8Array.from([0x30, body.length, ...body]);
}

// granted (PKIStatus 0 or 1), the token contains our 32-byte hash, and the first GeneralizedTime (TSTInfo genTime)
export function inspectResponse(resp, hashHex) {
  const b = resp; const hash = fromHex(hashHex);
  const hdr = b[1] & 0x80 ? 2 + (b[1] & 0x7f) : 2; // skip outer SEQUENCE header
  const granted = b[hdr] === 0x30 && b[hdr + 2] === 0x02 && b[hdr + 3] === 0x01 && (b[hdr + 4] === 0 || b[hdr + 4] === 1);
  let echoes = false;
  for (let i = 0; i + 32 <= b.length && !echoes; i++) if (b[i] === hash[0] && hash.every((x, k) => b[i + k] === x)) echoes = true;
  let genTime = null;
  for (let i = 0; i + 2 < b.length && !genTime; i++) {
    if (b[i] !== 0x18 || b[i + 1] < 15 || b[i + 1] > 24) continue;
    const s = new TextDecoder().decode(b.subarray(i + 2, i + 2 + b[i + 1]));
    const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\.\d+)?Z$/.exec(s);
    if (m) genTime = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] || ''}Z`;
  }
  return { granted, echoes_hash: echoes, gen_time_utc: genTime };
}

export async function anchor(hashHex, { fetchImpl = fetch } = {}) {
  const req = timeStampRequest(hashHex); const errors = [];
  for (const tsa of TSAS) {
    try {
      const r = await fetchImpl(tsa, { method: 'POST', headers: { 'content-type': 'application/timestamp-query', accept: 'application/timestamp-reply' }, body: req });
      const bytes = new Uint8Array(await r.arrayBuffer());
      const info = r.status === 200 ? inspectResponse(bytes, hashHex) : null;
      if (info?.granted && info.echoes_hash && info.gen_time_utc) return { ok: true, tsa, bytes, ...info };
      errors.push(`${tsa} http ${r.status} ${JSON.stringify(info)}`);
    } catch (e) { errors.push(`${tsa} ${String(e?.message || e).slice(0, 80)}`); }
  }
  return { ok: false, errors };
}
