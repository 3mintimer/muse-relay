import { getTextWidth } from '@evenrealities/pretext';

// Official G2/LVGL metrics, bundled by @evenrealities/pretext (MIT).
// The package supplies advances/kerning; no font tables or network calls live here.
export const G2_LINE_HEIGHT = 27;
export const G2_TEXT_LIMIT = 1000; // Also safe for startup/rebuild, not only upgrades.
const SCREEN_WIDTH = 576;

export interface TextInsets {
  paddingLength?: number;
  borderWidth?: number;
}

/** Complete rows inside a container; padding and borders occupy both edges. */
export function lineBudget(height: number, insets: TextInsets = {}): number {
  const nonnegative = (value: number) => Number.isFinite(value) ? Math.max(0, value) : 0;
  const inset = nonnegative(insets.paddingLength ?? 0) + nonnegative(insets.borderWidth ?? 0);
  return Math.max(0, Math.floor((nonnegative(height) - 2 * inset) / G2_LINE_HEIGHT));
}

const segmenter = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : undefined;
const continuation = /^[\p{Mark}\uFE00-\uFE0F\u{E0100}-\u{E01EF}\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]$/u;
const regional = /^[\u{1F1E6}-\u{1F1FF}]$/u;

function hangulType(char: string): string {
  const cp = char.codePointAt(0)!;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0xa960 && cp <= 0xa97c)) return 'L';
  if ((cp >= 0x1160 && cp <= 0x11a7) || (cp >= 0xd7b0 && cp <= 0xd7c6)) return 'V';
  if ((cp >= 0x11a8 && cp <= 0x11ff) || (cp >= 0xd7cb && cp <= 0xd7fb)) return 'T';
  if (cp >= 0xac00 && cp <= 0xd7a3) return (cp - 0xac00) % 28 ? 'LVT' : 'LV';
  return '';
}

function graphemes(text: string): string[] {
  if (segmenter) return Array.from(segmenter.segment(text), part => part.segment);
  // Older WebViews: retain common combining, emoji/flag and Hangul clusters.
  // Intl.Segmenter remains the full Unicode grapheme implementation when available.
  const result: string[] = [];
  let previous = '', regionalCount = 0;
  for (const char of text) {
    const left = hangulType(previous || char), right = hangulType(char);
    const hangul = (left === 'L' && ['L', 'V', 'LV', 'LVT'].includes(right))
      || (['LV', 'V'].includes(left) && ['V', 'T'].includes(right))
      || (['LVT', 'T'].includes(left) && right === 'T');
    const joined = continuation.test(char) || char === '\u200d' || previous === '\u200d'
      || (regional.test(char) && regionalCount % 2 === 1) || hangul;
    if (result.length && joined) result[result.length - 1] += char;
    else result.push(char);
    regionalCount = regional.test(char) ? regionalCount + 1 : 0;
    previous = char;
  }
  return result;
}

const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}\u3000-\u303f\uff00-\uffef]/u;
const opening = /^[([{（［｛〔〈《「『【〘〖〝‘“«]$/u;
const closing = /^[)\]}.,:;!?、。，．・：；？！ー…‥）］｝〕〉》」』】〙〗〟’”»ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ々〻ゝゞヽヾ]/u;

function legalBoundary(parts: string[], at: number): boolean {
  return !opening.test(parts[at - 1]) && !closing.test(parts[at] ?? '');
}

function preferredBoundary(parts: string[], at: number): boolean {
  const left = parts[at - 1], right = parts[at] ?? '';
  return legalBoundary(parts, at) && (left === ' ' || right === ' ' || left === '-'
    || cjk.test(left) || cjk.test(right));
}

function validWidth(width: number): void {
  if (!Number.isFinite(width) || width <= 0) throw new RangeError('G2 text width must be positive');
}

function widthOf(line: string): number {
  // LVGL ignores ASCII spaces at the start of a line. Retain them in the payload
  // so soft wrapping and page boundaries never discard source whitespace.
  return getTextWidth(line.replace(/^ +/, ''));
}

/**
 * Wrap at measured pixel widths, preferring words and CJK boundaries.
 * Width is the INNER viewport width. Hard blank lines, trailing newlines and
 * whitespace are retained; CRLF/CR become LF. Long words split at graphemes.
 * A single grapheme wider than the viewport stays intact (and can overflow).
 * Unsupported glyphs use the official package's firmware-placeholder estimate.
 */
export function wrapLines(text: string, width = SCREEN_WIDTH): string[] {
  validWidth(width);
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    const parts = graphemes(paragraph);
    if (!parts.length) { lines.push(''); continue; }
    let start = 0;
    while (start < parts.length) {
      let end = start, candidate = '';
      while (end < parts.length) {
        const next = candidate + parts[end];
        if (next.length > G2_TEXT_LIMIT || widthOf(next) > width) break;
        candidate = next;
        end++;
      }
      if (end === start) {
        if (parts[start].length > G2_TEXT_LIMIT) throw new RangeError('G2 text grapheme exceeds content limit');
        end++; // An indivisible glyph must make progress, even in a narrow box.
      } else if (end < parts.length) {
        let boundary = end;
        while (boundary > start && !preferredBoundary(parts, boundary)) boundary--;
        if (boundary === start) {
          boundary = end;
          while (boundary > start && !legalBoundary(parts, boundary)) boundary--;
        }
        if (boundary > start) end = boundary;
      }
      lines.push(parts.slice(start, end).join(''));
      start = end;
    }
  }
  return lines;
}

/** Pages never split a visual line and fit the stricter SDK rebuild limit. */
export function paginate(text: string, rows: number, width = SCREEN_WIDTH): string[] {
  if (!Number.isFinite(rows) || rows < 1) throw new RangeError('G2 text rows must be at least one');
  const rowCount = Math.floor(rows), pages: string[] = [], page: string[] = [];
  let length = 0;
  for (const line of wrapLines(text, width)) {
    const added = line.length + (page.length ? 1 : 0);
    if (page.length && (page.length === rowCount || length + added > G2_TEXT_LIMIT)) {
      pages.push(page.join('\n'));
      page.length = 0;
      length = 0;
    }
    length += line.length + (page.length ? 1 : 0);
    page.push(line);
  }
  if (page.length) pages.push(page.join('\n'));
  return pages;
}

/** First page with a visible omission marker, without splitting a grapheme. */
export function excerpt(text: string, rows: number, width = SCREEN_WIDTH): string {
  const pages = paginate(text, rows, width);
  if (pages.length === 1) return pages[0];
  const marker = '…';
  const visible = graphemes(pages[0]);
  let length = pages[0].length;
  // A final blank row can consume the last available SDK character as a newline.
  while (visible.length && length + marker.length > G2_TEXT_LIMIT) length -= visible.pop()!.length;
  const lines = visible.join('').split('\n');
  const last = graphemes(lines.pop() ?? '');
  const prefix = lines.length ? `${lines.join('\n')}\n` : '';
  while (last.length && widthOf(last.join('') + marker) > width) last.pop();
  return prefix + last.join('') + marker;
}
