const INVALID_WINDOWS_FILE_NAME_CHARS = /[<>:"/\\|?*]/g;
const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function sanitizeFileName(title: string): string {
  const sanitized = title
    .replace(INVALID_WINDOWS_FILE_NAME_CHARS, "_")
    .replace(/[\u0000-\u001f]/g, "_")
    .trim()
    .replace(/[. ]+$/g, "");

  const safeBaseName = sanitized || "Untitled";
  if (RESERVED_WINDOWS_NAMES.test(safeBaseName)) {
    return `${safeBaseName}_`;
  }

  return safeBaseName;
}

export function sanitizeNotionTitleForFileName(title: string): string | null {
  const trimmedTitle = title.trim();
  if (trimmedTitle === "." || trimmedTitle === "..") {
    return rejectUnsafeNotionTitle(title, "special path segment");
  }

  const withoutMarkdownExtension = trimmedTitle.replace(/\.md$/i, "");
  const sanitized = withoutMarkdownExtension
    .replace(INVALID_WINDOWS_FILE_NAME_CHARS, "_")
    .replace(/[\u0000-\u001f]/g, "_")
    .trim()
    .replace(/^[.\s]+/g, "")
    .replace(/[. ]+$/g, "");

  if (!sanitized || sanitized === "." || sanitized === "..") {
    return rejectUnsafeNotionTitle(title, "empty or special path segment after sanitization");
  }

  const safeBaseName = RESERVED_WINDOWS_NAMES.test(sanitized) ? `${sanitized}_` : sanitized;
  const safeFileName = `${safeBaseName}.md`;
  if (!isSafeVisibleFileName(safeFileName)) {
    return rejectUnsafeNotionTitle(title, `unsafe sanitized filename: ${safeFileName}`);
  }

  return safeFileName;
}

export function isSafeVisibleFileName(fileName: string): boolean {
  return Boolean(fileName) && !fileName.startsWith(".") && fileName !== "." && fileName !== "..";
}

function rejectUnsafeNotionTitle(title: string, reason: string): null {
  console.error("[LLM Wiki Sync][Sanitizer] rejected Notion title for filename", { title, reason });
  return null;
}
