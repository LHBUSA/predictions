export function priorDayCutoff(eventDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(eventDate))) {
    throw new TypeError('eventDate must be YYYY-MM-DD');
  }
  const day = new Date(`${eventDate}T00:00:00.000Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  day.setUTCHours(23, 59, 59, 999);
  return day.toISOString();
}
