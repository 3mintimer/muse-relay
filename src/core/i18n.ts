import type { Language, Locale } from './types';
import de from './locales/de.json';
import es from './locales/es.json';
import fr from './locales/fr.json';
import it from './locales/it.json';
import ko from './locales/ko.json';
import zhHans from './locales/zh-Hans.json';
import zhHant from './locales/zh-Hant.json';

export const locales: ReadonlyArray<{code:Locale;label:string;name:string}> = [
  {code:'en',label:'English',name:'English'},
  {code:'zh-Hans',label:'简体中文',name:'Simplified Chinese'},
  {code:'zh-Hant',label:'繁體中文',name:'Traditional Chinese'},
  {code:'ja',label:'日本語',name:'Japanese'},
  {code:'es',label:'Español',name:'Spanish'},
  {code:'fr',label:'Français',name:'French'},
  {code:'de',label:'Deutsch',name:'German'},
  {code:'it',label:'Italiano',name:'Italian'},
  {code:'ko',label:'한국어',name:'Korean'},
];

export function matchLocale(tag:string):Locale|undefined{
  const parts=tag.toLowerCase().replaceAll('_','-').split('-');
  if(parts[0]==='zh'){
    if(parts.includes('hans'))return 'zh-Hans';
    return parts.includes('hant')||parts.some(part=>['tw','hk','mo'].includes(part))?'zh-Hant':'zh-Hans';
  }
  return locales.find(locale=>locale.code===parts[0])?.code;
}
export function resolveLocale(language:Language, preferences:readonly string[]=typeof navigator==='undefined'?[]:[...(navigator.languages||[]),navigator.language]):Locale{
  if(language!=='system')return language;
  for(const tag of preferences){const locale=matchLocale(tag);if(locale)return locale;}
  return 'en';
}
export function validLanguage(value:unknown):value is Language{
  return value==='system'||locales.some(locale=>locale.code===value);
}
export const languageName=(language:Language)=>locales.find(locale=>locale.code===resolveLocale(language))!.name;
export const speechLanguage=(language:Language)=>resolveLocale(language).split('-')[0]!;

// English source strings identify messages; Japanese stays beside each source call.
// All other dictionaries are shared by the phone UI and G2 display.
const dictionaries:Partial<Record<Locale,Record<string,string>>>={de,es,fr,it,ko,'zh-Hans':zhHans,'zh-Hant':zhHant};
export function translate(language:Language,ja:string,en:string,values:Record<string,string|number>={}):string{
  const locale=resolveLocale(language);
  const message=locale==='ja'?ja:locale==='en'?en:dictionaries[locale]?.[en]??en;
  return message.replace(/\{(\w+)\}/g,(token,key:string)=>Object.hasOwn(values,key)?String(values[key]):token);
}
