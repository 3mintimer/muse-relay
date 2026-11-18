// Keep the same public language codes and native labels as the EvenHub app.
export const languages = Object.freeze({
  en: 'English', 'zh-Hans': '简体中文', 'zh-Hant': '繁體中文', ja: '日本語',
  es: 'Español', fr: 'Français', de: 'Deutsch', it: 'Italiano', ko: '한국어',
});

function knownLanguage(code) {
  return Object.hasOwn(languages, code) ? code : undefined;
}

function pageLanguage(path) {
  if (path === '/' || path === '/index.html') return 'en';
  const match = /^\/([^/]+)(?:\/index\.html|\/)?$/.exec(path);
  return match && knownLanguage(match[1]);
}

export function isGuidePage(path) {
  return Boolean(pageLanguage(path));
}

export function languageFromUrl(url) {
  return knownLanguage(url.searchParams.get('lang')) || pageLanguage(url.pathname) || 'en';
}

export function languageHref(language, hash = '') {
  const code = knownLanguage(language) || 'en';
  return (code === 'en' ? '/' : '/' + code + '/') + (hash.startsWith('#') ? hash : '');
}
