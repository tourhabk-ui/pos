/**
 * Дорожный Telegram-канал «Право на Руль» (t.me/pravonarul) — источник
 * закрытий и ограничений движения для ленты безопасности (10.10).
 *
 * Повод — разговор владельца 10.10: в ленте была строка о закрытии дороги на
 * Усть-Большерецк (Октябрьская коса), а приказа КГКУ «Камчатуправтодор»,
 * по которому её закрыли, не было. Приказ лежал снимком в этом канале, и
 * следующий его пост — «Закрытие Октябрьской косы продлили ещё на сутки» —
 * до ленты не доходил вовсе: канала не было среди наших источников. MAX-версию
 * канала автоматически не прочитать (у MAX нет открытого API, страница —
 * SPA), Telegram-зеркало раннер читает: проба 752 — HTTP 200, 10,9 тыс.
 * подписчиков, оба поста о косе на месте.
 *
 * Канал пишет про дороги вообще: ДТП, ремонт улиц, штрафы. В ленту туриста
 * берутся ТОЛЬКО ограничения проезда: тот же detectRoadRestriction, что у
 * МЧС, и два отсева сверху — происшествия (ДТП, авария) и городские улицы.
 * Открытие проезда закрытием не считается.
 *
 * Срок. Текст поста говорит его сам: «пока до 10 утра», «продлили ещё на
 * сутки — до десяти утра завтрашнего дня». Он и становится сроком пункта
 * (по времени Камчатки), а не наша неделя: недельный срок у сообщения «до
 * 10 утра» продержал бы закрытой открытую дорогу ещё шесть дней. Срок не
 * назван — сутки, и экран честно пишет «сообщение от», а не «действует до»
 * (isTechnicalExpiry). Округление — только вверх.
 *
 * Снимок. У поста со снимком основание может лежать на фото (приказ). Здесь
 * снимок только называется: что из названного ещё не проверено, решает
 * lib/safety/road-basis.ts, а приносит фото раннер второй ходкой.
 */
import { detectRoadRestriction, mchs_zones, saveEvent, type ParseResult, type SeismicEvent } from '@/lib/services/safety/seismic-parser';
import { decodeHtmlEntities } from '@/lib/html/entities';
import { stripTags } from '@/lib/html/text';

export const ROAD_CHANNEL = 'pravonarul';
/** Сколько последних постов страницы разбирать: t.me/s отдаёт около двадцати. */
const MAX_POSTS = 30;
/** Снимок — только с CDN Telegram: адрес отдаётся раннеру на скачивание. */
export const TELEGRAM_PHOTO_RE = /^https:\/\/cdn\d*\.telesco\.pe\/file\/[A-Za-z0-9_\-./%=?&]+$/;
const KAMCHATKA_OFFSET_MS = 12 * 3_600_000;
/** Срок, когда пост его не называет: сутки — тот же технический срок, что экран узнаёт. */
export const DEFAULT_ROAD_HOURS = 24;

export interface ChannelPost {
  /** t.me/pravonarul/18785 — тот же вид id, что у остальных Telegram-источников. */
  id: string;
  url: string;
  text: string;
  datetime: string;
  photos: string[];
}

/**
 * Посты страницы t.me/s/<канал>. Разбор — по блоку каждого поста, а не
 * склейкой «i-я дата с i-м текстом» (extractMessages): у канала много постов
 * без текста (одно видео), и счёт по порядку приписывал бы текст чужой дате.
 */
export function parseChannelPosts(html: string, channel: string = ROAD_CHANNEL): ChannelPost[] {
  const posts: ChannelPost[] = [];
  const marker = `data-post="${channel}/`;
  const chunks = html.split(marker).slice(1);
  for (const chunk of chunks) {
    const idMatch = /^(\d{1,9})"/.exec(chunk);
    if (!idMatch) continue;
    const msgId = idMatch[1];
    const textMatch = /class="tgme_widget_message_text js-message_text"[^>]*>([\s\S]*?)<\/div>/.exec(chunk);
    const text = textMatch
      ? decodeHtmlEntities(stripTags(textMatch[1].replace(/<br\s*\/?>/gi, '\n'))).replace(/[ \t]+\n/g, '\n').trim()
      : '';
    const timeMatch = /<time[^>]+datetime="([^"]+)"/.exec(chunk);
    const photos = [...chunk.matchAll(/tgme_widget_message_photo_wrap[^"]*"[^>]*style="[^"]*background-image:url\('([^']+)'\)/g)]
      .map((m) => m[1])
      .filter((u) => TELEGRAM_PHOTO_RE.test(u));
    if (!timeMatch) continue;
    posts.push({
      id: `t.me/${channel}/${msgId}`,
      url: `https://t.me/${channel}/${msgId}`,
      text,
      datetime: timeMatch[1],
      photos,
    });
    if (posts.length >= MAX_POSTS) break;
  }
  return posts;
}

// Границы слов — явные по кириллице: `\b` в регэкспах JS знает только
// латиницу, и `\bдтп\b` не совпал бы ни с одним постом.
/** Происшествие, а не ограничение: «перекрыли движение после ДТП» — не про маршрут туриста. */
const INCIDENT_RE = /(?<![а-яё])дтп(?![а-яё])|авари[яиюей]|столкновени|столкнул|(?<![а-яё])сбил[аи]?(?![а-яё])|наезд|погиб|пострадал|опрокинул|съехал[аи]?\s+в\s+кювет/i;
/** Городская улица: ремонт и перекрытие улиц Петропавловска к маршрутам туриста не относятся. */
const CITY_STREET_RE = /(?<![а-яё])улиц[аеуыи]?(?![а-яё])|(?<![а-яё])ул\.\s|(?<![а-яё])проспект|(?<![а-яё])пр-т(?![а-яё])|(?<![а-яё])переул|(?<![а-яё])площад[ьи](?![а-яё])/i;
/** Открытие — не закрытие: «косу открыли для проезда», «движение восстановлено». */
const REOPEN_RE = /открыл[аи]?\s+(?:для\s+)?(?:проезд|движени)|(?:проезд|движени)[а-яё]*\s+(?:снова\s+)?(?:открыт|восстановлен|возобновлен)|открыт[аоы]?\s+для\s+проезда/i;

/**
 * Формулировки канала, которых нет у МЧС: «косу закрыли для проезда»,
 * «Закрытие Октябрьской косы продлили». Общий detectRoadRestriction писался
 * под сводки МЧС («закрыт проезд», «ограничено движение») и этих оборотов не
 * берёт; расширять его для всех источников незачем — шаблон живёт здесь.
 */
const CHANNEL_ROAD_RE = /(?:закрыл[аи]?|перекрыл[аи]?)\s+(?:для\s+)?(?:проезд|движени)|закрыти[еяю][а-яё]*\s+[\s\S]{0,60}?(?:кос[аыуе]|дорог|трасс|перевал|участк|проезд|движени)|(?:кос[уа]|дорог[уа]|трасс[уа]|перевал)\s+(?:временно\s+)?(?:закрыли|перекрыли)/i;

const WORD_HOURS: Readonly<Record<string, number>> = {
  часу: 1, одного: 1, двух: 2, трёх: 3, трех: 3, четырёх: 4, четырех: 4, пяти: 5, шести: 6,
  семи: 7, восьми: 8, девяти: 9, десяти: 10, одиннадцати: 11, двенадцати: 12,
};

function to24h(h: number, part: string | undefined): number {
  const p = (part ?? '').toLowerCase();
  if (p.startsWith('вечер') && h < 12) return h + 12;
  if (p.startsWith('дня') && h >= 1 && h <= 6) return h + 12;
  if (p.startsWith('ноч') && h === 12) return 0;
  if (p.startsWith('утр') && h === 12) return 0;
  return h;
}

/**
 * Конец закрытия, названный текстом поста, — по времени Камчатки (UTC+12,
 * без перехода на летнее). «До 10 утра» без дня — ближайшие 10:00 после
 * публикации; «завтра» / «завтрашнего дня» — 10:00 следующего за публикацией
 * дня; «на сутки» без часа — сутки от публикации. Ничего не названо — null.
 */
export function closureUntil(text: string, publishedAt: Date): Date | null {
  const t = text.toLowerCase().replace(/ё/g, 'е');
  const num = /до\s+(\d{1,2})(?:[:.\-](\d{2}))?\s*(час[а-я]*|ч(?![а-я])|утра|вечера|дня|ночи)?/.exec(t);
  const word = /до\s+(часу|одного|двух|трех|четырех|пяти|шести|семи|восьми|девяти|десяти|одиннадцати|двенадцати)\s+(утра|вечера|дня|ночи|час[а-я]*)/.exec(t);
  let hour: number | null = null;
  let minute = 0;
  if (num && (num[3] || num[2])) {
    hour = to24h(Number(num[1]), num[3]);
    minute = num[2] ? Number(num[2]) : 0;
  } else if (word) {
    hour = to24h(WORD_HOURS[word[1]] ?? NaN, word[2]);
  }
  if (hour !== null && Number.isFinite(hour) && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
    // Камчатский календарь публикации: сдвиг на +12 ч и чтение UTC-полей.
    const local = new Date(publishedAt.getTime() + KAMCHATKA_OFFSET_MS);
    let candidate = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour, minute) - KAMCHATKA_OFFSET_MS;
    if (/завтра|завтрашн/.test(t)) {
      candidate += 24 * 3_600_000;
    } else if (candidate <= publishedAt.getTime()) {
      candidate += 24 * 3_600_000;
    }
    return new Date(candidate);
  }
  if (/на\s+сутки/.test(t)) return new Date(publishedAt.getTime() + 24 * 3_600_000);
  return null;
}

/** Пост канала → событие ленты, или null: не ограничение проезда, происшествие, городская улица, открытие. */
export function classifyRoadChannelPost(post: ChannelPost): SeismicEvent | null {
  const text = post.text;
  if (text.length < 20) return null;
  if (INCIDENT_RE.test(text) || CITY_STREET_RE.test(text) || REOPEN_RE.test(text)) return null;
  const road = detectRoadRestriction(text.toLowerCase()) ?? (CHANNEL_ROAD_RE.test(text) ? { severity: 2 as const } : null);
  if (!road) return null;
  const publishedAt = new Date(post.datetime);
  if (Number.isNaN(publishedAt.getTime())) return null;
  const until = closureUntil(text, publishedAt);
  const hours = until
    ? Math.max(1, Math.ceil((until.getTime() - publishedAt.getTime()) / 3_600_000))
    : DEFAULT_ROAD_HOURS;
  // Подпись канала («@pravonarul») в конце поста — не часть сообщения.
  const clean = text.replace(/\n*@pravonarul\s*$/i, '').trim();
  return {
    source_id: post.id,
    source_url: post.url,
    published_at: publishedAt,
    alert_type: 'road_closure',
    severity: road.severity,
    title: clean.split('\n')[0].replace(/[,;:\s]+$/, '').slice(0, 200) || 'Ограничение проезда',
    description: clean.slice(0, 800),
    affected_zones: mchs_zones(clean),
    expires_hours: hours,
  };
}

export interface RoadChannelResult extends ParseResult {
  /** Посты-ограничения со снимком: кандидаты на поиск основания (что уже проверено — решает road-basis). */
  photoCandidates: Array<{ external_id: string; photo_url: string }>;
}

/** Разбор страницы канала и запись ограничений в ленту. */
export async function ingestRoadChannelHtml(html: string, channel: string = ROAD_CHANNEL): Promise<RoadChannelResult> {
  const posts = parseChannelPosts(html, channel);
  const result: RoadChannelResult = { events: [], inserted: 0, skipped: 0, errors: [], rawItems: posts.length, photoCandidates: [] };
  for (const post of posts) {
    const event = classifyRoadChannelPost(post);
    if (!event) continue;
    result.events.push(event);
    try {
      const status = await saveEvent(event);
      if (status === 'inserted') result.inserted++;
      else result.skipped++;
      if (post.photos[0]) result.photoCandidates.push({ external_id: post.id, photo_url: post.photos[0] });
    } catch (e) {
      result.errors.push((e as Error).message);
    }
  }
  return result;
}
