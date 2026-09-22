import { langFrom, type Lang } from '../i18n/messages.ts';

/** Idioma do terminal: LABSIGN_LANG, depois o idioma do sistema. */
export function detectLang(): Lang {
  const forced = process.env.LABSIGN_LANG;
  if (forced === 'pt' || forced === 'en') return forced;
  return langFrom(process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale);
}
