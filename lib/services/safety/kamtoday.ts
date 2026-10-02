/**
 * Сводка Минтура — через kamtoday.ru (#2064, решение владельца 26.09).
 *
 * Первоисточник, kamgov.ru, закрыт для нас с обеих сторон: с Timeweb давно,
 * раннеру GitHub — 403 на все адреса (проба 605). Сводки «маршрут закрыт»,
 * «посещение не рекомендуется» неделями не доходили до статуса мест. Владелец
 * выбрал kamtoday.ru: лента «Новости Камчатки» открывается раннеру (проба
 * 606), и сводку она пересказывает целиком — с той же формулой «оперативная
 * сводка о доступности туристических объектов» (пробы 607, 608).
 *
 * Лента — общие новости края (мошенники, прививки, песцы). Прогонять её всю
 * через классификатор МЧС нельзя: бытовой пожар или ДТП стали бы тревогой на
 * карточке маршрута. Поэтому берётся ТОЛЬКО сводка Минтура, и узнаётся она
 * дважды: раннер открывает статьи с «Минтуризма» в заголовке, сервер разбирает
 * лишь те, что проходят isMinturBulletin — то же правило, что у kamgov.
 *
 * Источник в тревоге называется честно — «kamtoday.ru», а не «Минтур»: это
 * пересказ СМИ, и пересказ может разойтись с оригиналом (alert-origin).
 */
import { decodeHtmlEntities } from '@/lib/html/entities';
import { stripTags } from '@/lib/html/text';

/** Маркер перевода строки: в тексте статьи его не бывает. */
const BR = '\u0000BR\u0000';
import {
  classifyMchsItems, isMinturBulletin, saveEvent, type ParseResult,
} from '@/lib/services/safety/seismic-parser';

export const KAMTODAY_PREFIX = 'kamtoday';

/** Статья сводки, как её приносит раннер. */
export interface KamtodayArticle { url: string; title: string; pubDate: string; html: string }

/** Что увидел раннер в ленте — для честного исхода и здоровья источника. */
export interface KamtodayFetch { http: number; rss_items: number; matched: number }

/** Разбор плюс счёт статей, оказавшихся сводкой: «сводки не было» ≠ «тревог не вышло». */
export type KamtodayParseResult = ParseResult & { bulletins: number };

/**
 * Текст статьи строками — так его режет splitSummaryItems (по «\n»).
 *
 * Разметка kamtoday (проба 608): `<div itemprop="articleBody">`, пункты
 * разделены `<br><br>`, разделы — `<b>`. Переносы строк ВНУТРИ пункта в
 * исходнике есть («В парках «Ключевской»,\n «Вилючинский»…»), поэтому сырые
 * переводы строк сначала становятся пробелами, и только `<br>` — строкой.
 *
 * Маркера нет — null: разметка сменилась, и «текста нет» не должно читаться
 * как «сводка пустая».
 */
export function kamtodayArticleText(html: string): string | null {
  const at = html.indexOf('itemprop="articleBody"');
  if (at < 0) return null;
  const open = html.indexOf('>', at);
  if (open < 0) return null;
  const close = html.indexOf('</div>', open);
  const body = html.slice(open + 1, close < 0 ? open + 1 + 40_000 : close);
  // Разрыв строки — маркером до снятия тегов: общий stripTags (один на
  // репозиторий, сторож html-text) снимает <br> вместе с остальными.
  const flat = stripTags(body.replace(/[\r\n]+/g, ' ').replace(/<br\s*\/?>/gi, BR), ' ');
  const text = decodeHtmlEntities(flat.split(BR).join('\n'))
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  return text.length > 0 ? text : null;
}

/** Хвост адреса статьи — устойчивый id: одна статья — один id. */
function articleId(url: string): string {
  const slug = url.replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').pop() ?? url;
  return `${KAMTODAY_PREFIX}/${slug}`;
}

/**
 * Разобрать статьи сводки. rawItems — постов в ленте (feed жив, даже если
 * сводки сегодня нет); отказ ленты и сменившаяся разметка — ошибки словами.
 */
export async function ingestKamtodayArticles(
  articles: KamtodayArticle[],
  fetch: KamtodayFetch,
): Promise<KamtodayParseResult> {
  const result: KamtodayParseResult = { events: [], inserted: 0, skipped: 0, errors: [], rawItems: fetch.rss_items, bulletins: 0 };
  if (fetch.http < 200 || fetch.http >= 300) {
    result.errors.push(`kamtoday.ru: лента ответила раннеру ${fetch.http === 0 ? 'ничем' : `HTTP ${fetch.http}`}`);
    return result;
  }
  if (fetch.matched > articles.length) {
    result.errors.push(`kamtoday.ru: статей Минтура в ленте ${fetch.matched}, раннер принёс ${articles.length}`);
  }
  for (const a of articles) {
    const text = kamtodayArticleText(a.html);
    if (!text) {
      result.errors.push(`kamtoday.ru: в статье нет текста (разметка сменилась?) ${a.url}`);
      continue;
    }
    // Статья «про Минтур», но не сводка (интервью, итоги сезона) — не тревога.
    if (!isMinturBulletin(`${a.title} ${text}`)) continue;
    // Сводка была — даже если ни одного пункта не стало тревогой («маршруты
    // открыты» тоже сводка). По этому счёту судится здоровье kamtoday_bulletin.
    result.bulletins++;
    for (const event of classifyMchsItems(articleId(a.url), a.title, text, a.pubDate, a.url, KAMTODAY_PREFIX)) {
      result.events.push(event);
      try {
        const status = await saveEvent(event);
        if (status === 'inserted') result.inserted++;
        else result.skipped++;
      } catch (e) {
        result.errors.push((e as Error).message);
      }
    }
  }
  return result;
}
