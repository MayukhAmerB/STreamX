// HLS rendition helpers for the quality menu (pure).

export function formatHlsQualityLabel(level) {
  const height = Math.max(0, Number(level?.height) || 0);
  if (height > 0) return `${height}p`;
  const width = Math.max(0, Number(level?.width) || 0);
  if (width > 0) return `${width}w`;
  return "Auto";
}

/** Highest quality first, one entry per height. */
export function normalizeHlsQualityOptions(levels) {
  const seen = new Set();
  return (Array.isArray(levels) ? levels : [])
    .map((level, index) => ({
      index,
      height: Math.max(0, Number(level?.height) || 0),
      bitrate: Math.max(0, Number(level?.bitrate) || 0),
      label: formatHlsQualityLabel(level),
      value: Number(level?.height) > 0 ? String(level.height) : `level-${index}`,
    }))
    .sort((left, right) => right.height - left.height || right.bitrate - left.bitrate || right.index - left.index)
    .filter((option) => {
      const dedupeKey = option.height > 0 ? `height-${option.height}` : option.value;
      if (seen.has(dedupeKey)) return false;
      seen.add(dedupeKey);
      return true;
    });
}

/** The menu offers 1080p/720p when available, otherwise every rendition. */
export function pickVisibleQualityOptions(options) {
  const list = Array.isArray(options) ? options : [];
  const hdOptions = list.filter((option) => option.height === 1080 || option.height === 720);
  return hdOptions.length ? hdOptions : list;
}
