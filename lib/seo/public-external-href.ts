/**
 * Пользовательские внешние ссылки, которые нельзя ставить в HTML.
 *
 * KVERT (kvert.febras.net) официально отвечает только по HTTP; HTTPS
 * обрывается (проверка 27.11.2026). На https://vedarai.ru такая ссылка
 * даёт mixed content, поэтому в разметке оставляем название источника
 * без адреса. Серверные запросы к ленте KVERT по HTTP не трогаем.
 *
 * Глубокая форма Госуслуги41 `/pgu/volcano_info.htm` отвечает 403.
 * Запись в справочнике не переписываем: отфильтровываем только вывод.
 */
export function publicExternalHref(url: string | null | undefined): string | undefined {
  const href = (url ?? '').trim();
  if (!href) return undefined;
  let host = '';
  let path = '';
  try {
    const u = new URL(href);
    host = u.hostname.replace(/^www\./, '').toLowerCase();
    path = u.pathname;
  } catch {
    return href;
  }
  if (host === 'kvert.febras.net') return undefined;
  if (host === 'gosuslugi41.ru' && /\/pgu\/volcano_info\.htm$/i.test(path)) return undefined;
  return href;
}
