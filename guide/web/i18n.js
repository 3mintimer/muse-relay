import { japanese, englishAliases } from './messages.js';
import { languages } from './language.js';

let locale = 'en';
const catalogs = new Map([['en', englishAliases], ['ja', japanese]]);
export const getLocale = () => locale;
export function setLocale(value) { locale = Object.hasOwn(languages, value) ? value : 'en'; }

// Fetch only the selected translation on a reader's device.
export async function prepareLocale(code) {
  if (!Object.hasOwn(languages, code)) throw new Error('Unknown guide language');
  if (!catalogs.has(code)) {
    const { default: messages } = await import('./locales/' + code + '.js');
    catalogs.set(code, messages);
  }
}

export function messageFor(key, language) {
  return catalogs.get(language)?.[key] ?? englishAliases[key] ?? key;
}

/** Only explicit message keys are translated; user-entered text is never inspected. */
export function t(key, values = []) {
  const message = messageFor(key, locale);
  return message.replace(/\{(\d+)\}/g, (_, index) => String(values[Number(index)] ?? `{${index}}`));
}

const repository = 'https://github.com/3mintimer/muse-relay/blob/main/';
// Add a path only when a Japanese source file is available in the public export.
const japaneseDocs = new Set([
  'README.md', 'CONTRIBUTING.md',
  'docs/relay-setup.md', 'docs/server.md', 'docs/atoms3.md', 'docs/spaces.md',
  'docs/protocol.md', 'docs/public-source.md', 'adapters/gist/README.md',
]);

export function docHref(href, language = locale) {
  if (!href.startsWith(repository)) return href;
  const tail = href.slice(repository.length);
  const hash = tail.indexOf('#');
  const path = (hash < 0 ? tail : tail.slice(0, hash)).replace(/\.ja\.md$/, '.md');
  const fragment = hash < 0 ? '' : tail.slice(hash);
  return repository + (language === 'ja' && japaneseDocs.has(path) ? path.replace(/\.md$/, '.ja.md') : path) + fragment;
}

export function localizeDocText(value) {
  return value.replace(/https:\/\/github\.com\/3mintimer\/muse-relay\/blob\/main\/[A-Za-z0-9/._-]+\.md(?:#[^\s]*)?/g, href => docHref(href));
}

export function translatePage(root = document) {
  root.querySelectorAll('[data-i18n]').forEach(node => { node.textContent = t(node.getAttribute('data-i18n')); });
  for (const attribute of ['aria-label', 'placeholder', 'content', 'title']) {
    root.querySelectorAll(`[data-i18n-${attribute}]`).forEach(node => {
      node.setAttribute(attribute, t(node.getAttribute(`data-i18n-${attribute}`)));
    });
  }
  root.querySelectorAll('a[href]').forEach(node => {
    const href = node.dataset.docHref || node.getAttribute('href');
    if (href?.startsWith(repository)) {
      node.dataset.docHref = href;
      node.setAttribute('href', docHref(href));
    }
  });
}
