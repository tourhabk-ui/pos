/**
 * Язык документа по первому сегменту пути (вариант А дизайн-аудита 18.10).
 *
 * Минимальный механизм без i18n-инфраструктуры: корневой layout — единственный,
 * кто ставит <html lang>, а путь ему сообщает middleware заголовком
 * ROOT_LANG_HEADER (только для разделов /en и /zh — там заголовок и нужен).
 * Нет заголовка (все остальные страницы, сборка, тесты) — русский, как раньше.
 *
 * Значения — те же коды, что уже стоят в hreflang-парах посадочных
 * (lib/seo/query-landings: 'en', 'zh-CN', 'ru'), чтобы <html lang> и hreflang
 * не спорили о том, как называется язык страницы.
 */
export const ROOT_LANG_HEADER = 'x-vedar-pathname';

export type RootLang = 'ru' | 'en' | 'zh-CN';

export function htmlLangForPath(pathname: string | null | undefined): RootLang {
  const first = pathname?.split('/').filter(Boolean)[0];
  if (first === 'en') return 'en';
  if (first === 'zh') return 'zh-CN';
  return 'ru';
}
