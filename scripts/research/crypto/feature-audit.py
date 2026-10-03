# Research-only chronological feature audit for a short-horizon BTC up/down nowcast, built on the replay rows written
# by replay-v0.mjs. Train = first 75 % of windows by time, holdout = last 25 %. Nothing here uses market prices.
#   python scripts/research/crypto/feature-audit.py [D:/Workers/scratch/crypto]
import csv, json, math, sys
import numpy as np
from sklearn.linear_model import LogisticRegression

d = sys.argv[1] if len(sys.argv) > 1 else 'D:/Workers/scratch/crypto'
rows = [r for r in csv.DictReader(open(f'{d}/replay-v0-forecasts.csv')) if r['mom5'] and r['volRatio']]
for r in rows:
    for k in ('open', 'k', 'up', 'hour'): r[k] = int(float(r[k]))
    for k in ('p', 'z', 'mom5', 'volRatio', 'sig'): r[k] = float(r[k])
opens = sorted({r['open'] for r in rows}); split = opens[int(len(opens) * 0.75)]
clip = lambda p: np.clip(p, 1e-6, 1 - 1e-6)
ll = lambda y, p: float(-np.mean(y * np.log(clip(p)) + (1 - y) * np.log(1 - clip(p))))
br = lambda y, p: float(np.mean((p - y) ** 2))
from scipy.stats import norm  # noqa: E402

def feats(a, spec):
    cols = []
    for r in a:
        x = []
        if 'z' in spec: x.append(r['z'])
        if 'mom' in spec: x.append(r['mom5'])
        if 'volr' in spec: x += [r['volRatio'], r['z'] * r['volRatio']]
        if 'hour' in spec: x += [math.sin(2 * math.pi * r['hour'] / 24), math.cos(2 * math.pi * r['hour'] / 24)]
        cols.append(x)
    return np.array(cols)

out = {'split': split, 'by_checkpoint': {}}
for k in (14, 10, 5, 1):
    tr = [r for r in rows if r['k'] == k and r['open'] < split]; ho = [r for r in rows if r['k'] == k and r['open'] >= split]
    ytr = np.array([r['up'] for r in tr]); yho = np.array([r['up'] for r in ho])
    res = {'n_train': len(tr), 'n_holdout': len(ho), 'v0': {'brier': br(yho, np.array([r['p'] for r in ho])), 'logloss': ll(yho, np.array([r['p'] for r in ho]))}}
    # one-parameter vol scale: P = Phi(z / s), s fitted on train by grid search
    best = min(((ll(ytr, norm.cdf(np.array([r['z'] for r in tr]) / s)), s) for s in np.arange(0.6, 2.01, 0.02)))
    s = best[1]; ph = norm.cdf(np.array([r['z'] for r in ho]) / s)
    res['vol_scaled'] = {'scale': round(float(s), 2), 'brier': br(yho, ph), 'logloss': ll(yho, ph)}
    for name, spec in (('logit_z', {'z'}), ('logit_z_mom', {'z', 'mom'}), ('logit_z_mom_volr', {'z', 'mom', 'volr'}), ('logit_all', {'z', 'mom', 'volr', 'hour'})):
        m = LogisticRegression(C=1.0, max_iter=1000).fit(feats(tr, spec), ytr)
        p = m.predict_proba(feats(ho, spec))[:, 1]
        res[name] = {'brier': br(yho, p), 'logloss': ll(yho, p), 'coef': [round(float(c), 3) for c in m.coef_[0]]}
    out['by_checkpoint'][f'T-{k}'] = {kk: ({k2: (round(v2, 4) if isinstance(v2, float) else v2) for k2, v2 in vv.items()} if isinstance(vv, dict) else vv) for kk, vv in res.items()}
json.dump(out, open(f'{d}/feature-audit.json', 'w'), indent=2)
print(json.dumps(out, indent=2))
