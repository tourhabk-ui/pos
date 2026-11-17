/**
 * lib/tours/tour-promotion.ts — АКЦИЯ ОПЕРАТОРА НА КАРТОЧКЕ ТУРА.
 *
 * ── Зачем (слово владельца 17.11 «покажи») ────────────────────────────────
 *
 * Наблюдение за сайтами партнёров нашло у «Лагуны Экспедиции» акцию «Для
 * жителей Дальнего Востока». На вопрос, показывать ли её на наших карточках,
 * владелец ответил «покажи». Строки акции кладёт миграция 1460
 * (`tour_promotions`): что даёт акция по туру, кому и на какие поездки, срок
 * бронирования, адрес, откуда условия взяты, и день сверки.
 *
 * ── Правило одно на карточку и на ответ агенту ────────────────────────────
 *
 * Акция видна, пока сегодня по Камчатке лежит в сроке бронирования
 * (`booking_from` … `booking_until` включительно). После последнего дня она
 * пропадает сама: ни ручного снятия, ни второй миграции. Карточка тура
 * (`app/catalog/tours/[id]`) и `getTourDetails` (MCP, A2A, чат Кузьмича)
 * читают одним запросом и говорят одними словами — `promotionView`.
 *
 * ── Чего акция не делает ──────────────────────────────────────────────────
 *
 * - Цену в заявке не меняет: право на акцию (прописка) Ведар не проверяет,
 *   его и итоговую сумму подтверждает оператор. Это сказано под акцией.
 * - Порядок туров на витринах не меняет (правило 1в, §0): её показывают
 *   только карточка этого тура и ответ о нём.
 * - Не прочиталась — карточка блока не показывает, а агенту сказано, что
 *   прочитать не удалось: «не прочиталось» не равно «акций нет» (§4.0).
 */
import { pool } from '@/lib/db-pool';
import { logText } from '@/lib/log/log-text';

export interface TourPromotion {
  title: string;
  offer: string;
  conditions: string;
  /** YYYY-MM-DD, по Камчатке, включительно. */
  booking_from: string;
  /** YYYY-MM-DD, по Камчатке, включительно — последний день показа. */
  booking_until: string;
  source_url: string;
  /** YYYY-MM-DD — когда условия сверены с источником. */
  checked_on: string;
}

export type TourPromotionsRead =
  | { state: 'ok'; items: TourPromotion[] }
  | { state: 'failed' };

/** Сегодня по Камчатке (UTC+12, без перехода на летнее время). */
export function kamchatkaDay(now: number = Date.now()): string {
  return new Date(now + 12 * 3600 * 1000).toISOString().slice(0, 10);
}

export const ACTIVE_TOUR_PROMOTIONS_SQL = `
  SELECT title, offer, conditions,
         to_char(booking_from, 'YYYY-MM-DD')  AS booking_from,
         to_char(booking_until, 'YYYY-MM-DD') AS booking_until,
         source_url,
         to_char(checked_on, 'YYYY-MM-DD')    AS checked_on
    FROM tour_promotions
   WHERE tour_id = $1
     AND $2::date BETWEEN booking_from AND booking_until
   ORDER BY booking_until, id`;

/** Идёт ли акция в этот день — то же условие, что в запросе. */
export function isPromotionActive(p: Pick<TourPromotion, 'booking_from' | 'booking_until'>, day: string): boolean {
  return p.booking_from <= day && day <= p.booking_until;
}

export async function loadActiveTourPromotions(
  tourId: number,
  opts: { now?: number } = {},
): Promise<TourPromotionsRead> {
  const day = kamchatkaDay(opts.now);
  try {
    const { rows } = await pool.query<TourPromotion>(ACTIVE_TOUR_PROMOTIONS_SQL, [tourId, day]);
    // Второй раз — тем же правилом в коде: строка вне срока не уходит, даже
    // если база ответила не тем, что спросили.
    return { state: 'ok', items: rows.filter((r) => isPromotionActive(r, day)) };
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    console.error('[tour-promotion] акции тура не прочитаны', {
      tourId,
      sqlstate: typeof code === 'string' ? logText(code, 10) : null,
      message: logText(err instanceof Error ? err.message : err, 200),
    });
    return { state: 'failed' };
  }
}

// ── Слова ────────────────────────────────────────────────────────────────

const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

/** «2026-12-01» → «1 декабря 2026». Не дата — null. */
export function promotionDate(iso: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const month = MONTHS_GEN[Number(m[2]) - 1];
  const day = Number(m[3]);
  if (!month || day < 1 || day > 31) return null;
  return `${day} ${month} ${m[1]}`;
}

/** Под каждой акцией: что Ведар делает и чего не делает. */
export const PROMOTION_PRICE_NOTE =
  'Цену в заявке Ведар не меняет: право на акцию и итоговую сумму подтверждает оператор.';

export interface TourPromotionView {
  title: string;
  /** «Бронирование с 18 ноября по 1 декабря 2026» */
  period: string;
  offer: string;
  conditions: string;
  note: string;
  /** «Условия — с сайта оператора, сверены 17 ноября 2026» */
  source: string;
  source_url: string;
}

export function promotionView(p: TourPromotion): TourPromotionView {
  const from = promotionDate(p.booking_from);
  const until = promotionDate(p.booking_until);
  const checked = promotionDate(p.checked_on);
  const sameYear = p.booking_from.slice(0, 4) === p.booking_until.slice(0, 4);
  const fromShort = from && sameYear ? from.replace(/ \d{4}$/, '') : from;
  return {
    title: p.title.trim(),
    period: from && until ? `Бронирование с ${fromShort} по ${until}` : `Бронирование по ${until ?? p.booking_until}`,
    offer: p.offer.trim(),
    conditions: p.conditions.trim(),
    note: PROMOTION_PRICE_NOTE,
    source: `Условия — с сайта оператора${checked ? `, сверены ${checked}` : ''}`,
    source_url: p.source_url,
  };
}

/** Блок ответа агенту. ok без акций — пустая строка: молчание не утверждение. */
export function promotionsForAgent(read: TourPromotionsRead): string {
  if (read.state === 'failed') {
    return 'Акции оператора по этому туру прочитать не удалось — не говори, что акций нет; скажи, что это уточняется у оператора.';
  }
  if (read.items.length === 0) return '';
  return read.items.map((p) => {
    const v = promotionView(p);
    return `Акция оператора «${v.title}» (бери ТОЛЬКО отсюда, не выдумывай). ${v.period}.\n`
      + `По этому туру: ${v.offer}\n`
      + `Кому и на какие поездки: ${v.conditions}\n`
      + `${v.note} ${v.source}: ${v.source_url}`;
  }).join('\n');
}
