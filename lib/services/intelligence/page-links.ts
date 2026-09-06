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
 * Текст ссылки, который НИЧЕГО не говорит о записи.
 *
 * Замер taaft 06.09: у карточки на /new/ самой длинной ссылкой оказывается
 * ценник — «Free + from $9.00», — а названия инструмента внутри ссылок нет
 * вовсе. Имя записи там живёт в адресе: /ai/<инструмент>.
 *
 * Список НАРОЧНО узкий: ценник, дата, значок места в подборке. Он отвечает на
 * вопрос «эта строка вообще про что-то?», а не «похожа ли она на заголовок» —
 * второе было бы угадыванием, и под него подпал бы короткий настоящий
 * заголовок.
 */
const LABEL_ONLY: RegExp[] = [
  // Валюта перед числом («from $9.00») и после него («от 990 ₽») — оба формата.
  /^(?:free|бесплатно)?[\s+·|—-]*(?:from|от)?\s*[$€₽]\s?\d/i,
  /^(?:free|бесплатно)?[\s+·|—-]*(?:from|от)?\s*\d[\d\s.,]*\s*[$€₽]$/i,
  /^[A-Za-zА-Яа-я]{3,8}\s+\d{1,2},\s+\d{4}$/,
  /^\d{1,2}[./]\d{1,2}[./]\d{2,4}$/,
  /^#\d+\s+(?:in|в)\s+/i,
];

export function looksLikeLabel(title: string): boolean {
  return LABEL_ONLY.some((re) => re.test(title.trim()));
}

/**
 * Имя из адреса — не выдумка, а собственный опознаватель источника:
 * /ai/homeexterior-ai → «Homeexterior ai». Берётся ТОЛЬКО когда текст ссылки
 * оказался ярлыком; настоящий заголовок адресом не подменяется.
 */
export function nameFromSlug(url: string): string {
  let path = '';
  try { path = new URL(url).pathname; } catch { return ''; }
  const slug = path.split('/').filter(Boolean).pop() ?? '';
  const words = slug.replace(/[-_]+/g, ' ').replace(/\.\w+$/, '').trim();
  if (!words) return '';
  return words.charAt(0).toUpperCase() + words.slice(1);
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

  /**
   * Одна карточка — несколько ссылок на один адрес.
   *
   * Замер taaft 06.09: карточка инструмента разбита на ссылки «имя»,
   * «слоган», «цена», «дата», и все ведут на /ai/<инструмент>. Пока
   * оставлялась ПЕРВАЯ, заголовками выходили «Free + from $9.00» и
   * «Sep 5, 2026» — правда о разметке, но не о записи.
   *
   * Поэтому из ссылок на один адрес остаётся САМАЯ ДЛИННАЯ: она и несёт
   * смысл. Правило детерминированное — не «выбрать похожее на заголовок».
   */
  const byUrl = new Map<string, PageLink>();
  let anchors = 0;

  ANCHOR.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ANCHOR.exec(html)) !== null) {
    anchors++;

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
    const title = textOf(m[2]).slice(0, MAX_TITLE);
    if (title.length < MIN_TITLE) continue;

    const already = byUrl.get(url);
    if (already) {
      if (title.length > already.title.length) already.title = title;
      continue;
    }
    // Потолок считает АДРЕСА, а не якоря: у уже взятой записи заголовок
    // продолжает улучшаться и после того, как список набран.
    if (byUrl.size >= limit) continue;
    byUrl.set(url, { title, url, snippet: '' });
  }

  // Ярлык вместо заголовка — берём имя из адреса, а сам ярлык оставляем
  // подписью: цена и дата у новинки не мусор, просто они не заголовок.
  const links = [...byUrl.values()].map((link) => {
    if (!looksLikeLabel(link.title)) return link;
    const name = nameFromSlug(link.url);
    return name ? { ...link, title: name, snippet: link.title } : link;
  });

  return { links, anchors, prefix };
}
