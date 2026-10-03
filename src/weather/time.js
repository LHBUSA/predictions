// CLI climate-day windows. The NWS Daily Climate Report covers midnight to midnight LOCAL STANDARD TIME
// all year (during daylight time that is 1 a.m. to 1 a.m. local clock time).

export function cliWindow(date, station) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new TypeError('date must be YYYY-MM-DD');
  const offset = Number(station?.lstOffsetHours);
  if (!Number.isInteger(offset)) throw new TypeError('station.lstOffsetHours is required');
  const startMs = Date.parse(`${date}T00:00:00Z`) - offset * 3600000;
  return Object.freeze({
    date,
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + 86400000).toISOString(),
    timezone: station.tz,
    lstOffsetHours: offset,
    definition: `00:00-24:00 local standard time (UTC${offset >= 0 ? '+' : ''}${offset})`,
  });
}

export function hoursBetween(aIso, bIso) {
  return (Date.parse(bIso) - Date.parse(aIso)) / 3600000;
}
