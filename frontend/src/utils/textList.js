function removeLegacyWrapper(value, index, lastIndex) {
  let text = String(value ?? "").trim();
  if (index === 0) text = text.replace(/^\[\s*/, "");
  if (index === lastIndex) text = text.replace(/\s*\]$/, "");

  const quote = text.charAt(0);
  if ((quote === "'" || quote === '"') && text.endsWith(quote)) {
    text = text.slice(1, -1).trim();
  }

  return text;
}

export function normalizeTextList(value) {
  let items = value;

  if (typeof value === "string") {
    const raw = value.trim();
    if (!raw) return [];

    try {
      const parsed = JSON.parse(raw);
      items = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      items = raw.includes(",") ? raw.split(",") : raw.split(/\r?\n/);
    }
  }

  if (!Array.isArray(items)) return [];

  const lastIndex = items.length - 1;
  return items
    .map((item, index) => removeLegacyWrapper(item, index, lastIndex))
    .filter(Boolean);
}
