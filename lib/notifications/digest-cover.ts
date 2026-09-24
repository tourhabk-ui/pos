/**
 * Обложка AI-дайджеста — собственная карточка выпуска, а не картинка
 * генератора (снимок владельца 24.09).
 *
 * До этого обложку сочинял генератор по ОДНОМУ заголовку выпуска: из «обратной
 * разработки формата AutoCAD» вышло серое изометрическое здание с водяным
 * знаком в углу. Выпуск — это два-три разных материала, и случайная сцена по
 * одному из них не может быть уместной для всех. Карточка с датой и
 * заголовками выпуска уместна всегда, не стоит денег и не зависит от того,
 * жив ли генератор.
 *
 * Картинку Telegram забирает сам — по ссылке превью (`link_preview_options`),
 * поэтому карточка живёт на публичном адресе `/api/og/digest-cover`. Чтобы на
 * нашем домене нельзя было нарисовать чужой текст под нашей маркой, параметры
 * подписаны HMAC от CRON_SECRET. Секрета нет — ссылки нет, и вызывающий
 * падает на прежнюю обложку генератора (отказ не глушится: он виден в том,
 * что обложка другая, и в логе).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const DIGEST_COVER_PATH = '/api/og/digest-cover';

/** Сколько заголовков выносится на карточку и какой длины. */
export const COVER_MAX_TITLES = 3;
export const COVER_TITLE_MAX = 90;
const DATE_MAX = 40;

/**
 * Заголовки материалов выпуска: жирные строки, кроме шапки «AI-дайджест · …»
 * и подписи «Почему важно:». Порядок — как в посте.
 */
export function digestCoverTitles(digestHtml: string): string[] {
  return [...digestHtml.matchAll(/<b>([^<]+)<\/b>/g)]
    .map((m) => m[1].replace(/\s+/g, ' ').trim())
    .filter((t) => t && !/^AI-дайджест/i.test(t) && !/^Почему важно/i.test(t))
    .slice(0, COVER_MAX_TITLES)
    .map((t) => (t.length > COVER_TITLE_MAX ? `${t.slice(0, COVER_TITLE_MAX - 1).trimEnd()}…` : t));
}

function canonical(date: string, titles: string[]): string {
  return JSON.stringify({ d: date, t: titles });
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', `digest-cover:${secret}`).update(payload).digest('hex').slice(0, 32);
}

/** Подписанный адрес карточки. null — секрета нет или заголовков нет. */
export function digestCoverUrl(date: string, titles: string[]): string | null {
  const secret = process.env.CRON_SECRET;
  if (!secret || titles.length === 0) return null;
  const d = date.slice(0, DATE_MAX);
  const t = titles.slice(0, COVER_MAX_TITLES).map((x) => x.slice(0, COVER_TITLE_MAX));
  const base = (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru').replace(/\/+$/, '');
  const params = new URLSearchParams();
  params.set('d', d);
  for (const x of t) params.append('t', x);
  params.set('s', sign(canonical(d, t), secret));
  return `${base}${DIGEST_COVER_PATH}?${params.toString()}`;
}

export type CoverParams = { date: string; titles: string[] };

/** Проверяет подпись. null — подпись не сошлась, секрета нет или параметры не те. */
export function verifyDigestCover(search: URLSearchParams): CoverParams | null {
  const secret = process.env.CRON_SECRET;
  const s = search.get('s');
  const date = search.get('d');
  const titles = search.getAll('t');
  if (!secret || !s || !date || titles.length === 0 || titles.length > COVER_MAX_TITLES) return null;
  if (date.length > DATE_MAX || titles.some((t) => t.length > COVER_TITLE_MAX)) return null;
  const expected = Buffer.from(sign(canonical(date, titles), secret));
  const got = Buffer.from(s);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  return { date, titles };
}
