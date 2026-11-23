import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { collectPublicAssets } from './build.mjs';
import { createGuide } from './worker.mjs';
import { languages, languageFromUrl, languageHref, isGuidePage } from './web/language.js';
import { prepareLocale, messageFor } from './web/i18n.js';
import { japanese, englishAliases } from './web/messages.js';

const codes = ['en', 'zh-Hans', 'zh-Hant', 'ja', 'es', 'fr', 'de', 'it', 'ko'];
const origin = 'https://guide.example';
let assets;
const handler = async () => createGuide(await (assets ??= collectPublicAssets()));
const escapeHtml = value => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function assertText(html, tag, text) {
  assert.match(html, new RegExp(`<${tag}\\b[^>]*>${escapeRegExp(escapeHtml(text))}</${tag}>`));
}

test('the nine language routes match the app when its source is available', async () => {
  assert.deepEqual(Object.keys(languages), codes);
  for (const code of codes) {
    assert.ok(languages[code].trim());
    const path = languageHref(code);
    assert.equal(path, code === 'en' ? '/' : `/${code}/`);
    assert.equal(isGuidePage(path), true);
    assert.equal(languageFromUrl(new URL(`${origin}${path}#setup`)), code);
    assert.equal(languageFromUrl(new URL(`${origin}/?lang=${code}#voice`)), code);
    assert.equal(languageHref(code, '#feedback'), `${path}#feedback`);
    assert.equal(languageHref(code, 'draft=never-include'), path);
  }
  assert.equal(isGuidePage('/en/'), true);
  assert.equal(isGuidePage('/ja'), true);
  assert.equal(isGuidePage('/ja/index.html'), true);
  assert.equal(isGuidePage('/not-a-language/'), false);
  assert.equal(languageFromUrl(new URL(`${origin}/ja/?lang=en#voice`)), 'en');
  assert.equal(languageFromUrl(new URL(`${origin}/?lang=unknown`)), 'en');

  // The standalone Sites checkout has no app tree; this comparison is optional there.
  let appSource;
  try { appSource = await readFile(new URL('../src/core/i18n.ts', import.meta.url), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (appSource) {
    const declaration = appSource.match(/export const locales[^=]*=\s*\[([\s\S]*?)\n\];/);
    assert.ok(declaration, 'Could not find the app locale list.');
    const appCodes = [...declaration[1].matchAll(/\bcode\s*:\s*['"]([^'"]+)['"]/g)].map(match => match[1]);
    assert.deepEqual(codes, appCodes);
  }
});

test('every translation covers all canonical messages and preserves numbered placeholders', async () => {
  const sourceKeys = Object.keys(japanese);
  const placeholders = text => [...text.matchAll(/\{\d+\}/g)].map(match => match[0]).sort();
  for (const code of codes) {
    await prepareLocale(code);
    const dictionary = code === 'en' ? null : code === 'ja' ? japanese : (await import(`./web/locales/${code}.js`)).default;
    if (dictionary) assert.deepEqual(Object.keys(dictionary).sort(), [...sourceKeys].sort(), `${code}: message keys`);
    for (const key of sourceKeys) {
      const text = dictionary ? dictionary[key] : englishAliases[key] ?? key;
      assert.equal(typeof text, 'string', `${code}: ${key}`);
      assert.ok(text.trim(), `${code}: empty translation for ${key}`);
      assert.deepEqual(placeholders(text), placeholders(key), `${code}: placeholders for ${key}`);
      assert.equal(messageFor(key, code), text, `${code}: dictionary was not registered`);
    }
  }
});

test('all nine pages contain translated titles, actions, navigation, and language links without JavaScript', async () => {
  const guide = await handler(), etags = new Set();
  for (const code of codes) {
    await prepareLocale(code);
    const response = await guide.fetch(new Request(origin + languageHref(code)), {});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-language'), code);
    etags.add(response.headers.get('etag'));
    const html = await response.text();
    assert.match(html, new RegExp(`<html lang="${code}"`));
    for (const [tag, key] of [
      ['title', 'Muse Relay — Guide & setup'],
      ['h2', 'Choose a relay method'],
      ['strong', 'Relay through GitHub Gist'],
      ['strong', 'Relay through an ESP32 device'],
      ['strong', 'Relay through a Linux computer'],
      ['strong', 'Custom relay server'],
      ['summary', 'Share phone location (optional)'],
      ['a', 'Update an existing relay for 0.3.30'],
      ['summary', 'Update from 0.3.36 to 0.4.1'],
      ['button', 'Copy upgrade request for Muse'],
      ['h3', 'Reply suggestions on G2'],
      ['h2', 'Ask Muse to set it up'],
      ['button', 'Copy instructions'],
      ['summary', 'Reply arrived, but no transcript'],
      ['a', 'Setup'],
      ['p', 'You can install the app once it appears in the store.'],
    ]) {
      const translated = messageFor(key, code);
      if (code !== 'en') assert.notEqual(translated, key, `${code}: untranslated ${key}`);
      assertText(html, tag, translated);
    }
    const storeLink = html.match(/<a\b[^>]*\bid="download"[^>]*>([^<]*)<\/a>/);
    assert.ok(storeLink?.[0].includes('href="https://hub.evenrealities.com/catalogue/com.threemintimer.muserelay"'), code);
    assert.equal(storeLink[1], escapeHtml(messageFor('Get it on Even Hub', code)));
    for (const target of codes) {
      const tag = html.match(new RegExp(`<a\\b(?=[^>]*\\bdata-language="${target}")[^>]*>`))?.[0];
      assert.ok(tag, `${code}: missing ${target} language link`);
      for (const [name, value] of [['href', languageHref(target)], ['lang', target], ['hreflang', target]]) assert.ok(tag.includes(`${name}="${value}"`), `${code}: language link ${name}`);
      if (target === code) assert.ok(tag.includes('aria-current="page"'));
    }
    for (const anchor of ['setup', 'connection', 'voice', 'relay', 'feedback', 'g2muse', 'reply-suggestions-upgrade']) assert.ok(html.includes(`id="${anchor}"`));
    assert.ok(html.includes('src="/app.js"') && html.includes('href="/style.css"'));
    assert.ok(html.includes(`/docs/relay-setup${code === 'ja' ? '.ja' : ''}.md`));
    assert.ok(html.includes(`/docs/relay-setup${code === 'ja' ? '.ja' : ''}.md#relay-upgrade`));
    assert.ok(html.includes(`/blob/v0.4.1-beta.1/docs/relay-setup${code === 'ja' ? '.ja' : ''}.md#reply-suggestions-upgrade`));
    for (const [file, key] of [
      ['chat-reply.png', 'Last page of a Muse answer on G2, with a tap hint for suggested replies.'],
      ['reply-choices.png', 'Three suggested replies listed on G2, with one row highlighted.'],
      ['chat-menu.png', 'G2 system menu showing reply-suggestion settings for the chat.'],
    ]) {
      assert.ok(html.includes(`href="/screenshots/${file}"`));
      const image = html.match(new RegExp(`<img\\b[^>]*src="/screenshots/${escapeRegExp(file)}"[^>]*>`))?.[0];
      assert.ok(image?.includes(` alt="${escapeHtml(messageFor(key, code))}"`), `${code}: ${file} alt`);
    }
    assert.ok(html.includes('action="/api/feedback"'));
    assert.match(html, /<input type="checkbox" name="share">/);
  }
  assert.equal(etags.size, codes.length, 'Each translated HTML page needs its own ETag.');
  assert.ok(!etags.has(null));
});

test('legacy language queries, English alias, and conditional requests use the correct HTML', async () => {
  const guide = await handler();
  for (const code of codes) {
    const response = await guide.fetch(new Request(`${origin}/?lang=${code}#connection`), {});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-language'), code);
  }
  for (const [path, code] of [['/en/', 'en'], ['/ja', 'ja'], ['/ja/index.html', 'ja'], ['/index.html?lang=ja', 'ja'], ['/ja/?lang=en', 'en']]) {
    const response = await guide.fetch(new Request(origin + path), {});
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-language'), code);
  }
  const japanese = await guide.fetch(new Request(`${origin}/ja/`), {});
  const etag = japanese.headers.get('etag');
  const head = await guide.fetch(new Request(`${origin}/ja/`, { method: 'HEAD' }), {});
  assert.equal(head.headers.get('etag'), etag); assert.equal(await head.text(), '');
  assert.equal((await guide.fetch(new Request(`${origin}/ja/`, { headers: { 'if-none-match': etag } }), {})).status, 304);
  assert.equal((await guide.fetch(new Request(`${origin}/`, { headers: { 'if-none-match': etag } }), {})).status, 200);
  assert.equal((await guide.fetch(new Request(`${origin}/not-a-language/`), {})).status, 404);
});
