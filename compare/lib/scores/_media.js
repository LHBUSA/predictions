export function absoluteAsset(raw, origin) {
  const value = String(raw || '').trim();
  if (!value) return null;
  try {
    const url = new URL(value, origin);
    if (url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}
