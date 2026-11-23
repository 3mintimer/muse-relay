export function isSuggestionMode(value) {
  return value === 'auto' || value === 'always';
}

// Keep the complete text selectable on G2 and send exactly what the user read.
export function parseReplySuggestions(value) {
  if (!Array.isArray(value) || value.length !== 3) return;
  for (const text of value) {
    if (typeof text !== 'string' || !text || text.length > 96 || [...text].length > 48
      || text.trim() !== text || /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u.test(text)) return;
  }
  if (new Set(value).size === 3) return [value[0], value[1], value[2]];
}
