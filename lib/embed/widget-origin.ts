/**
 * lib/embed/widget-origin.ts — откуда пришёл человек, открывший виджет
 * партнёра: хост и путь страницы ЧУЖОГО сайта, на которой стоит наш скрипт.
 *
 * ── Повод (аудит 15.10, находка WID-measure, W5) ───────────────────────────
 *
 * До 15.10 домен партнёра не записывался нигде. Форма заявки не слала ни
 * адреса, ни реферера, а чат писал `domain: origin` — но запрос идёт из
 * iframe с vedarai.ru, и Origin там всегда наш. На вопрос «с какого сайта и
 * страницы пришёл человек» ответа не было, а белый список `widget_domains`
 * сверялся только в заголовке CORS, от которого ничего не зависит.
 *
 * Теперь скрипты на сайте партнёра (public/widget/embed.js и выдача
 * /api/widget/lead.js) кладут в адрес iframe `host` и `path` страницы —
 * `location.hostname` и `location.pathname`, БЕЗ query и hash: там бывают
 * телефон, почта, ключи. Сервер сверяет хост со списком партнёра и пишет один
 * из трёх исходов:
 *
 *   listed    — хост в `widget_domains` (сам домен или его поддомен);
 *   unlisted  — хост прислан, но в списке его нет;
 *   not_sent  — хоста нет (старый скрипт из кэша, окно открыто напрямую).
 *
 * ── Это сигнал, а не замок ────────────────────────────────────────────────
 *
 * Хост присылает браузер посетителя, и подделать его может кто угодно:
 * открыть /widget/<slug>?host=mestechkokam.ru руками или прислать любое тело.
 * `listed` значит «пришло с хостом из списка», а не «доказано, что с сайта
 * партнёра». Ни доступ, ни выдача от этого исхода не зависят — по нему
 * только СЧИТАЮТ. Запирать по нему что-либо нельзя.
 *
 * Модуль без серверных зависимостей: им пользуются и страницы виджета в
 * браузере, и роуты.
 */

/** Род виджета: форма заявки (lead.js) или окно чата (embed.js). */
export type WidgetKind = 'form' | 'chat';

export const WIDGET_HOST_CHECKS = ['listed', 'unlisted', 'not_sent'] as const;
export type WidgetHostCheck = (typeof WIDGET_HOST_CHECKS)[number];

/** Хост и путь, как их прислал скрипт; null — не прислано или мусор. */
export interface WidgetOriginInput {
  host: string | null;
  path: string | null;
}

/** Запись «откуда пришёл» для source_data лида и chat_sessions.widget_origin. */
export interface WidgetOrigin extends WidgetOriginInput {
  host_check: WidgetHostCheck;
}

/** Длина пути — с запасом на обычный адрес страницы, но не на портянку. */
export const WIDGET_PATH_MAX = 200;

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOST_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);

/**
 * Имя хоста, как его даёт `location.hostname`: буквы, цифры, дефис и точки.
 * Всё прочее (порт, схема, `@`, пробелы, юникод без punycode) — null: в
 * таблицу идёт только то, что похоже на хост, а не произвольная строка.
 */
export function normalizeWidgetHost(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const h = raw.trim().toLowerCase().replace(/\.$/, '');
  if (!h || h.length > 253) return null;
  return HOST_RE.test(h) ? h : null;
}

/**
 * Путь страницы без query и hash. Длинные ряды цифр (7 и больше — телефон,
 * номер документа) и сегменты с `@` (почта) заменяются: путь страницы
 * партнёра не должен приносить нам чужие ПД, даже если сайт кладёт их в адрес.
 */
export function normalizeWidgetPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let p = raw.split(/[?#]/, 1)[0] ?? '';
  p = p.trim();
  if (!p.startsWith('/')) return null;
  if (/[\s\u0000-\u001f\u007f]/.test(p)) return null;
  p = p
    .split('/')
    .map((seg) => (seg.includes('@') || /%40/i.test(seg) ? '{email}' : seg))
    .join('/')
    .replace(/\d{7,}/g, '{digits}');
  if (p.length > WIDGET_PATH_MAX) p = p.slice(0, WIDGET_PATH_MAX);
  return p;
}

/** Разбор адреса; не адрес — null (хоста нет: исход not_sent, а не отказ). */
function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** Хост из заголовка Referer (у выдачи lead.js браузер шлёт его сам). */
export function hostFromReferer(referer: string | null | undefined): string | null {
  if (!referer) return null;
  const url = parseUrl(referer);
  return url ? normalizeWidgetHost(url.hostname) : null;
}

/**
 * Хост в списке партнёра: сам домен или его поддомен. То же правило, что
 * у прежних проверок Origin в роутах виджета (`www.` и `https://` в записи
 * списка допускаются).
 */
export function hostInWidgetDomains(host: string, domains: readonly string[] | null | undefined): boolean {
  const h = host.toLowerCase();
  return (domains ?? []).some((d) => {
    if (typeof d !== 'string') return false;
    const clean = d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/:].*$/, '').replace(/\.$/, '');
    if (!clean) return false;
    return h === clean || h.endsWith(`.${clean}`);
  });
}

/** Исход сверки хоста со списком. Подделываемо — см. шапку. */
export function classifyWidgetHost(
  host: string | null,
  domains: readonly string[] | null | undefined,
): WidgetHostCheck {
  if (!host) return 'not_sent';
  return hostInWidgetDomains(host, domains) ? 'listed' : 'unlisted';
}

/** Сырой ввод (тело запроса) → проверенная запись с исходом. */
export function widgetOrigin(
  rawHost: unknown,
  rawPath: unknown,
  domains: readonly string[] | null | undefined,
): WidgetOrigin {
  const host = normalizeWidgetHost(rawHost);
  // Путь без хоста ни о чём не говорит: чей это путь — неизвестно.
  const path = host ? normalizeWidgetPath(rawPath) : null;
  return { host, path, host_check: classifyWidgetHost(host, domains) };
}

/**
 * Хост и путь из адреса окна виджета (`?host=…&path=…`, их ставят скрипты
 * партнёра). Если своих параметров нет, а окно открыто внутри нашего же окна
 * виджета (форма заявки из чата), — берутся параметры родительского окна из
 * `document.referrer`: адрес того же источника, путь `/widget/…`.
 */
export function readWidgetOriginParams(
  search: string,
  referrer?: string | null,
  ownOrigin?: string | null,
): WidgetOriginInput {
  const own = new URLSearchParams(search);
  const host = normalizeWidgetHost(own.get('host'));
  if (host) return { host, path: normalizeWidgetPath(own.get('path')) };
  const parent = referrer && ownOrigin ? parseUrl(referrer) : null;
  if (parent && parent.origin === ownOrigin && parent.pathname.startsWith('/widget/')) {
    const ph = normalizeWidgetHost(parent.searchParams.get('host'));
    if (ph) return { host: ph, path: normalizeWidgetPath(parent.searchParams.get('path')) };
  }
  return { host: null, path: null };
}
