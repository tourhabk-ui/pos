/**
 * Telegram-канал турпортала края t.me/visitkamchatka41 — еженедельная сводка
 * Минтуризма о доступности туристических объектов (карт-бланш владельца 29.10).
 *
 * Сводка Минтура — единственный официальный документ о том, какие парки и
 * маршруты закрыты и по каким дорогам не проехать. Её канонический адрес —
 * kamgov.ru/mintur, который раннеру отвечает 403 (проба 605); пересказ
 * kamtoday.ru умер 20.10. Турпортал visitkamchatka.ru публикует тот же текст
 * в новостях и слово в слово — в своём Telegram-канале (пробы 1016–1018:
 * посты 4920 от 21.10 и 4936 от 29.10). RSS у портала нет (Bitrix), а
 * несуществующий путь он отдаёт как 200 со страницей поиска; превью Telegram
 * разбирается уже проверенным путём «Права на Руль» (road-channel), поэтому
 * источник — канал.
 *
 * С прода t.me закрыт, страницу приносит раннер (cron-safety-ingest.yml,
 * поле visitkamchatka_html). Пост сводки опознаётся первой строкой —
 * заголовком «Еженедельная сводка о доступности туристических объектов»
 * (isMinturBulletin) — и разбирается построчно той же classifyMchsItems, что
 * сводка с kamgov: закрытые парки — park_closure по справочнику парков, дороги
 * — road_closure, вулканы — «не приближаться». Прочие посты канала (фестивали,
 * конкурсы) проходят через classifyMchsItem как посты MAX: мусор отбрасывается
 * там же.
 *
 * Живость источника — по СВЕЖИМ сводкам (`rawItems`): превью Telegram каждый
 * прогон отдаёт одни и те же старые посты (урок 07.09), и «постов разобрано»
 * ничего не значит; «вставлено» — тоже: сводка, где всё открыто, законно не
 * даёт ни одного события. Свежей считается сводка не старше окна
 * FRESH_SUMMARY_HOURS по дате поста — её ставит Telegram, не мы.
 */

import { parseChannelPosts, type ChannelPost } from '@/lib/services/safety/road-channel';
import {
  classifyMchsItems, isMinturBulletin, saveEvent, VISITKAMCHATKA_PREFIX, type ParseResult, type SeismicEvent,
} from '@/lib/services/safety/seismic-parser';

export const VISITKAMCHATKA_CHANNEL = 'visitkamchatka41';
export const VISITKAMCHATKA_CHANNEL_URL = `https://t.me/s/${VISITKAMCHATKA_CHANNEL}`;

/**
 * Сводка выходит раз в неделю (29.07, 07.08, 13.08, 20.08, 03.09, 10.09,
 * 21.10, 29.10 по списку портала — с перерывами). Десять суток без выпуска
 * ещё «выпуска не было», дольше — повод посмотреть, читается ли канал.
 */
export const FRESH_SUMMARY_HOURS = 24 * 10;

export interface SummaryPost {
  /** `tg/<id поста>` — хвост external_id после префикса источника. */
  id: string;
  url: string;
  title: string;
  body: string;
  datetime: string;
}

/**
 * Пост сводки: первая строка — заголовок, по которому сводку узнаёт
 * isMinturBulletin; остальное — её пункты. Пост без такого заголовка
 * (новость, фестиваль) — не сводка: заголовка у него нет, весь текст идёт
 * описанием, как у постов MAX.
 */
export function splitSummaryPost(post: ChannelPost): SummaryPost {
  const lines = post.text.split('\n').map((l) => l.trim());
  const first = lines.find((l) => l.length > 0) ?? '';
  const isSummary = isMinturBulletin(first);
  const body = isSummary ? lines.slice(lines.indexOf(first) + 1).join('\n').trim() : post.text;
  return {
    id: `tg/${post.id.split('/').pop()}`,
    url: post.url,
    title: isSummary ? first : '',
    body,
    datetime: post.datetime,
  };
}

/** Посты канала, которые являются сводкой Минтура (по заголовку). */
export function summaryPostsOf(html: string): SummaryPost[] {
  return parseChannelPosts(html, VISITKAMCHATKA_CHANNEL)
    .map(splitSummaryPost)
    .filter((p) => p.title !== '');
}

export function isFreshSummary(post: SummaryPost, now: Date): boolean {
  const t = new Date(post.datetime).getTime();
  return Number.isFinite(t) && now.getTime() - t <= FRESH_SUMMARY_HOURS * 3_600_000;
}

/** Чистый разбор поста в события — без базы, для сторожей и переписи. */
export function classifyChannelPost(post: ChannelPost): SeismicEvent[] {
  const s = splitSummaryPost(post);
  if (!s.body.trim()) return [];
  return classifyMchsItems(s.id, s.title, s.body, s.datetime, s.url, VISITKAMCHATKA_PREFIX);
}

export interface VisitkamchatkaChannelResult extends ParseResult {
  /** Сколько постов дала страница — отдельно от свежих сводок. */
  postsParsed: number;
  /** Сводки Минтура на странице: дата и ссылка, свежие и старые. */
  summaries: Array<{ url: string; datetime: string; fresh: boolean }>;
}

/**
 * Приём страницы канала, принесённой раннером. Три исхода (§4.0):
 * страница не разобралась ни на один пост — ошибка, не «тихо»; постов есть,
 * свежей сводки нет — rawItems 0, и здоровье источника посчитает тишину от
 * последней свежей; сводка есть — события в ленте, повтор снимает saveEvent.
 */
export async function ingestVisitkamchatkaChannelHtml(
  html: string,
  now: Date = new Date(),
): Promise<VisitkamchatkaChannelResult> {
  const posts = parseChannelPosts(html, VISITKAMCHATKA_CHANNEL);
  const result: VisitkamchatkaChannelResult = {
    events: [], inserted: 0, skipped: 0, errors: [], rawItems: 0, postsParsed: posts.length, summaries: [],
  };
  if (posts.length === 0) {
    result.errors.push(`${VISITKAMCHATKA_CHANNEL_URL}: страница не разобралась ни на один пост (разметка data-post / ответ раннера)`);
    return result;
  }
  for (const post of posts) {
    const s = splitSummaryPost(post);
    if (s.title !== '') {
      const fresh = isFreshSummary(s, now);
      result.summaries.push({ url: s.url, datetime: s.datetime, fresh });
      if (fresh) result.rawItems = (result.rawItems ?? 0) + 1;
    }
    if (!s.body.trim()) continue;
    for (const event of classifyMchsItems(s.id, s.title, s.body, s.datetime, s.url, VISITKAMCHATKA_PREFIX)) {
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
