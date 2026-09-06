/**
 * Разбор страницы-ленты: ссылки на записи из обычного HTML.
 *
 * Заведено 06.09 по решению владельца «Anthropic должен быть главным».
 * Замер с прода (prod-check run 24) показал, что ленты у Anthropic НЕТ вовсе:
 * `anthropic.com/news` отдаёт HTTP 200 и 471 КБ HTML, а `/rss.xml`,
 * `/feed.xml`, `/news/rss.xml` и `/rss` — 404 все четыре. Догадка владельца
 * («публикуется через страницы») подтвердилась замером.
 *
 * Значит главный источник читается разбором страницы. Разбор ДЕТЕРМИНИРОВАННЫЙ
 * и без ключей: Firecrawl без ключа возвращает пустой список молча, и путь к
 * главному источнику оказался бы мёртвым, ничего об этом не сказав.
 *
 * Третье состояние (§4.0) здесь обязательно: страница, где ссылок ноль, — это
 * ОТКАЗ разбора, а не «новостей нет». Поэтому возвращается не просто список,
 * а перепись: сколько всего было ссылок на странице и сколько прошло отбор.
 * Ноль записей при сотне ссылок значит «вёрстка поменялась», и говорить об
 * этом надо вслух, а не выдавать за тишину источника.
 */

import { stripTags } from '@/lib/html/text';
import { decodeHtmlEntities } from '@/lib/html/entities';

export interface PageLink {
  title: string;
  url: string;
  snippet: string;
}

export interface PageExtract {
  links: PageLink[];
  /** Сколько всего якорей нашлось в теле — отличает «вёрстка другая» от «страница не пришла». */
  anchors: number;
  /** Отбор: путь ссылки начинается с этого префикса. */
  prefix: string;
}

/** Заголовок короче этого — не запись, а стрелка навигации или «Читать далее». */
const MIN_TITLE = 8;
const MAX_TITLE = 200;

/**
 * Закрывающий тег читается КАК БРАУЗЕРОМ: `</a >`, `</a\n>` и `</a foo>` —
 * тоже конец ссылки. Требование точного `</a>` — это js/bad-tag-filter,
 * ровно тот дефект, из-за которого в репозитории завели общий разбор
 * (lib/html/text). Здесь он значил бы, что текст всей страницы после такой
 * ссылки становится её заголовком.
 */
const ANCHOR = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\b[^>]*>/gi;

/**
 * Текст ссылки. Снятие тегов и разворот сущностей — ОБЩИЕ на репозиторий
 * (lib/html/text, lib/html/entities): свой разбор здесь означал бы тридцать
 * первую копию правила, которое уже разъезжалось (сторожа html-text,
 * html-entities). Разделитель — пробел: иначе «Announcements<h3>Claude</h3>»
 * склеится в одно слово.
 */
function textOf(html: string): string {
  return decodeHtmlEntities(stripTags(html, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * Префикс отбора по умолчанию — путь самой страницы со слешем на конце.
 * Для `https://www.anthropic.com/news` это `/news/`: записи лежат ПОД
 * индексом, сам индекс в улов не попадает.
 */
export function defaultPrefix(pageUrl: string): string {
  let path = '/';
  try { path = new URL(pageUrl).pathname; } catch { return '/'; }
  if (path === '' || path === '/') return '/';
  return path.endsWith('/') ? path : `${path}/`;
}

export function extractPageLinks(
  html: string,
  pageUrl: string,
  opts: { prefix?: string; limit?: number } = {},
): PageExtract {
  const prefix = opts.prefix ?? defaultPrefix(pageUrl);
  const limit = opts.limit ?? 8;

  let base: URL;
  try { base = new URL(pageUrl); } catch { return { links: [], anchors: 0, prefix }; }

  const seen = new Set<string>();
  const links: PageLink[] = [];
  let anchors = 0;

  ANCHOR.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ANCHOR.exec(html)) !== null) {
    anchors++;
    if (links.length >= limit) continue;

    const href = m[1].trim();
    if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) continue;

    let abs: URL;
    try { abs = new URL(href, base); } catch { continue; }
    if (abs.protocol !== 'https:' && abs.protocol !== 'http:') continue;
    if (abs.hostname !== base.hostname) continue;
    if (!abs.pathname.startsWith(prefix)) continue;
    // Сам индекс — не запись.
    if (abs.pathname === prefix || abs.pathname === prefix.replace(/\/$/, '')) continue;

    abs.hash = '';
    const url = abs.toString();
    if (seen.has(url)) continue;

    const title = textOf(m[2]).slice(0, MAX_TITLE);
    if (title.length < MIN_TITLE) continue;

    seen.add(url);
    links.push({ title, url, snippet: '' });
  }

  return { links, anchors, prefix };
}
