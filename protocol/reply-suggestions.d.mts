export function isSuggestionMode(value: unknown): value is 'auto' | 'always';
export function parseReplySuggestions(value: unknown): [string, string, string] | undefined;
