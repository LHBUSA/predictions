# Vendored: propsports-markets (canonical Kalshi market layer)

Copied UNCHANGED from LHBUSA/propbetedge-workers `workers/propsports-markets/src/` at main `eb01c5d3f3d2f7cd8d258d58f844407cf135cd99` (2026-10-03).
Predictions never talks to Kalshi directly: it reads markets through the canonical propsports-markets Worker
(service binding MARKETS) and uses these pure functions for normalization (kalshi-norm/2) and lifecycle (market-history/1).

Do not edit these files here. Update by re-copying from canonical; test/vendor-parity.test.js compares bytes when the canonical checkout exists.

| file | sha256 |
|---|---|
| core.js | bc260bb530f49c0ed06b3a3ec0bceb17754767a055fb3236f068e4e28be16fcc |
| match.js | b8881606bb9aa305afdd24a019c505cbb1119a67e763aee76fad58ebf8b31494 |
| history.js | 76744668f6899f9b948730d442757d377eaf116efec5f0e854f14e1b5ae0a62f |
| api-order.js | d54656def1780ada5e4a472e60e972bffc0aee7b543e4815b2b4136c4e1416ab |
