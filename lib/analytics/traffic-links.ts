/**
 * Ссылки со страницы трафика (`/hub/admin/traffic`) — на саму страницу захода.
 *
 * Владелец 25.09: «по кнопке переход на страницу захода». Пути и источники в
 * журнале пишет не платформа, а посетитель: путь — из адресной строки, источник
 * — из заголовка Referer. Поэтому ссылкой становится только то, что форма
 * допускает, а остальное остаётся текстом:
 *
 * - путь — только адрес НАШЕГО сайта: с одного `/`. `//evil.example` браузер
 *   читает как чужой хост, `javascript:` и прочие схемы путём не являются;
 * - источник — только http(s). Referer подделывается одной строкой curl, и
 *   `javascript:` в href админки выполнился бы от имени администратора.
 */

/** Путь сайта → href, либо null: не путь, чужой хост или управляющие символы. */
export function internalHref(path: string): string | null {
  if (!/^\/(?![/\\])/.test(path)) return null;
  if (/[\s\\\u0000-\u001f]/.test(path)) return null;
  return path;
}

/** Внешний адрес источника → href, либо null: только http и https. */
export function externalHref(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    // Не адрес вовсе (обрезанная строка, «(direct)») — показать текстом.
    return null;
  }
  return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
}
