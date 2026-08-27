const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/** Returns the Notion file UUID directly before the original filename. */
export function extractNotionMediaStableId(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const fileId = segments[segments.length - 2];
  return UUID.test(fileId) ? fileId.toLowerCase() : null;
}
