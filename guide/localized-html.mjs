import { messageFor, docHref } from './web/i18n.js';
import { languages, languageHref } from './web/language.js';

const entities = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
function decode(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (_, entity) =>
    entity[0] === '#' ? String.fromCodePoint(parseInt(entity.slice(entity[1].toLowerCase() === 'x' ? 2 : 1), entity[1].toLowerCase() === 'x' ? 16 : 10)) : entities[entity.toLowerCase()]);
}
function escape(value) {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

/** Render the same translation hooks for readers with and without JavaScript. */
export function localizedHtml(source, language) {
  let translated = 0;
  let html = source.replace(/(<([a-z][\w:-]*)\b[^>]*\bdata-i18n="([^"]*)"[^>]*>)([^<]*)(<\/\2\s*>)/gi, (_, start, tag, key, text, end) => {
    translated++;
    return start + escape(messageFor(decode(key), language)) + end;
  });
  const expected = (source.match(/\bdata-i18n="/g) || []).length;
  if (translated !== expected) throw new Error('data-i18n must mark a text-only element.');
  html = html.replace(/<[a-z][\w:-]*\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi, tag => {
    for (const attribute of ['aria-label', 'placeholder', 'content', 'title']) {
      const match = tag.match(new RegExp(`\\bdata-i18n-${attribute}="([^"]*)"`));
      if (match) tag = tag.replace(new RegExp(`(\\s${attribute}=")[^"]*"`), (_, prefix) => prefix + escape(messageFor(decode(match[1]), language)) + '"');
    }
    if (/^<a\b/i.test(tag)) tag = tag.replace(/(\shref=")([^"]*)"/, (_, prefix, value) => prefix + escape(docHref(decode(value), language)) + '"');
    if (/^<html\b/i.test(tag)) tag = tag.replace(/\slang="[^"]*"/, ` lang="${language}"`);
    return tag;
  });
  const links = Object.entries(languages).map(([code, label]) =>
    `<a href="${languageHref(code)}" lang="${code}" hreflang="${code}" data-language="${code}"${code === language ? ' aria-current="page"' : ''}>${escape(label)}</a>`).join('');
  return html.replace('<!-- language-links -->', links)
    .replace('<span id="language-name">English</span>', `<span id="language-name">${escape(languages[language])}</span>`);
}
