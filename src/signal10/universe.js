// Signal 10 point-in-time universe: S&P 500 membership as published on each historical date.
// Source: fja05680/sp500 "S&P 500 Historical Components & Changes (Updated).csv" (MIT), compiled from the public
// S&P 500 change record. Each row is the member list effective on that date; a date D uses the latest row <= D.
// Pure module (Worker-safe): no fs, no network.

export function loadComponents(csv) {
  const rows = [];
  for (const line of String(csv).split(/\r?\n/).slice(1)) {
    const m = line.match(/^(\d{4}-\d{2}-\d{2}),"?([^"]*)"?$/);
    if (!m) continue;
    rows.push({ date: m[1], tickers: m[2].split(',').map((t) => t.trim()).filter(Boolean) });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return rows;
}

// Member list effective on `date` (latest row with row.date <= date). Null before the first row.
export function membersOn(components, date) {
  let lo = 0, hi = components.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (components[mid].date <= date) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found < 0 ? null : components[found];
}

// Every ticker that was a member at any point on/after `from` (the download set).
export function universeTickers(components, from) {
  const set = new Set();
  const start = membersOn(components, from);
  if (start) start.tickers.forEach((t) => set.add(t));
  for (const r of components) if (r.date >= from) r.tickers.forEach((t) => set.add(t));
  return [...set].sort();
}
