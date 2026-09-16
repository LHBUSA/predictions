export function calibrationBins(rows, { bins = 10, probabilityField = 'probability', actualField = 'actual' } = {}) {
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array');
  if (!Number.isInteger(bins) || bins < 2) throw new RangeError('bins must be an integer >= 2');

  const bucketed = Array.from({ length: bins }, (_, index) => ({
    index,
    lower: index / bins,
    upper: (index + 1) / bins,
    count: 0,
    probabilitySum: 0,
    actualSum: 0
  }));

  for (const row of rows) {
    const p = Number(row[probabilityField]);
    const actual = Number(row[actualField]);
    if (!Number.isFinite(p) || p < 0 || p > 1) continue;
    if (!(actual === 0 || actual === 1)) continue;
    const index = Math.min(bins - 1, Math.floor(p * bins));
    const bucket = bucketed[index];
    bucket.count += 1;
    bucket.probabilitySum += p;
    bucket.actualSum += actual;
  }

  return Object.freeze(bucketed.map((bucket) => Object.freeze({
    lower: bucket.lower,
    upper: bucket.upper,
    count: bucket.count,
    meanProbability: bucket.count ? bucket.probabilitySum / bucket.count : null,
    empiricalRate: bucket.count ? bucket.actualSum / bucket.count : null
  })));
}

export function expectedCalibrationError(bins) {
  const total = bins.reduce((sum, bin) => sum + bin.count, 0);
  if (!total) return null;
  return bins.reduce((sum, bin) => {
    if (!bin.count) return sum;
    return sum + (bin.count / total) * Math.abs(bin.meanProbability - bin.empiricalRate);
  }, 0);
}
