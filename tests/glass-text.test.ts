import test from 'node:test';
import assert from 'node:assert/strict';
import { getTextWidth, measureTextWrap } from '@evenrealities/pretext';
import { G2_LINE_HEIGHT, G2_TEXT_LIMIT, lineBudget, wrapLines, paginate, excerpt } from '../src/core/glass-text.ts';

test('row budgets use the actual inner viewport and wrapping uses proportional G2 metrics', () => {
  assert.equal(G2_LINE_HEIGHT, 27);
  assert.deepEqual([250, 186, 94, 42, 58, 288].map(height => lineBudget(height)), [9, 6, 3, 1, 2, 10]);
  assert.equal(lineBudget(288, { paddingLength: 8, borderWidth: 2 }), 9);
  assert.equal(lineBudget(26), 0);
  assert.equal(lineBudget(27, { paddingLength: 14 }), 0);
  assert.equal(getTextWidth('日'), 20);
  assert.ok(getTextWidth('W') > getTextWidth('i'));
  assert.equal(wrapLines('i'.repeat(100), 560).length, 1);
  assert.equal(wrapLines('W'.repeat(100), 560).length, 3);
  assert.deepEqual(wrapLines('日'.repeat(29), 560), ['日'.repeat(28), '日']);
  assert.deepEqual(wrapLines('日本語。次', 60), ['日本', '語。次']);
});

test('explicit empty lines, whitespace-only lines and trailing newlines survive page boundaries', () => {
  const text = 'first\r\n\r\n  \r\nlast\n';
  assert.deepEqual(wrapLines(text), ['first', '', '  ', 'last', '']);
  assert.deepEqual(paginate(text, 2), ['first\n', '  \nlast', '']);
  for (const input of ['', '   ', '\n\n', 'a\n', '\nfirst\n\nlast\n']) {
    assert.equal(paginate(input, 2).join('\n'), input);
  }
  const sentence = 'The quick brown fox jumps over the lazy dog.  Next words.';
  const lines = wrapLines(sentence, 200);
  assert.equal(lines.join(''), sentence, 'soft wrapping retains every original character');
  assert.ok(lines.every(line => measureTextWrap(line, 200).lineCount === 1));
  assert.deepEqual(lines.flatMap(line => line.trim().split(/ +/).filter(Boolean)), sentence.trim().split(/ +/));
  assert.equal(paginate(sentence, 2, 200).join('\n'), lines.join('\n'));
});

test('hard wraps and page limits preserve graphemes, including combined accents and emoji', () => {
  const text = 'e\u0301👨‍👩‍👧‍👦👍🏽🇯🇵日本語'.repeat(15);
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const original = Array.from(segmenter.segment(text), part => part.segment);
  const lines = wrapLines(text, 60);
  assert.equal(lines.join(''), text);
  assert.deepEqual(lines.flatMap(line => Array.from(segmenter.segment(line), part => part.segment)), original);
  assert.ok(lines.every(line => measureTextWrap(line, 60).lineCount === 1));
  const narrow = 'i'.repeat(5000);
  const pages = paginate(narrow, 9);
  assert.equal(pages.join('').replaceAll('\n', ''), narrow);
  assert.ok(pages.every(page => page.length <= G2_TEXT_LIMIT && page.split('\n').length <= 9));
  assert.ok(pages.every(page => measureTextWrap(page, 576).lineCount <= 9));
  assert.deepEqual(wrapLines('👨‍👩‍👧‍👦', 5), ['👨‍👩‍👧‍👦'], 'a too-wide grapheme remains indivisible');
});

test('excerpts signal omitted content within the same row, pixel and SDK limits', () => {
  const text = '日本語とEnglish words。 e\u0301👍🏽 '.repeat(30);
  const short = excerpt(text, 2, 180);
  assert.ok(short.endsWith('…'));
  assert.equal(short.split('\n').length, 2);
  assert.ok(measureTextWrap(short, 180).lineCount <= 2);
  assert.ok(short.length <= G2_TEXT_LIMIT);
  assert.equal(excerpt('short\n', 2, 180), 'short\n');
  assert.ok(excerpt(' '.repeat(999) + '\n\nx', 2).length <= G2_TEXT_LIMIT, 'ellipsis also fits after a full-size page ending in a blank row');
  assert.throws(() => paginate('text', 0), /rows/);
  assert.throws(() => wrapLines('text', 0), /width/);
});
