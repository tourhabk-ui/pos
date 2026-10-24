/**
 * lib/ai/booking-intent.ts
 *
 * Determines whether a user message contains interest in a tour/activity,
 * then fetches matching tours from DB so the chat can surface them inline.
 */

import { pool } from '@/lib/db-pool';
import { namedVolcanoes, pickToursForMessage, volcanoNamePatterns } from '@/lib/ai/tour-place-relevance';
import { publicTourSql } from '@/lib/tours/public-visibility';

export interface TourSuggestion {
  id: number;
  /** Адрес карточки (ЧПУ, миграция 1114); null — ссылка по числу. */
  slug: string | null;
  title: string;
  description: string | null;
  base_price: number;
  /** За что стоит base_price — нужно форме брони в чате (lib/tours/booking-total). */
  price_unit: string | null;
  multi_day_count: number | null;
  duration_hours: number | null;
  activity_type: string | null;
  location_type: string | null;
  location: string | null;
  tour_image: string | null;
  operator_name: string;
  /** partners.slug / partners.is_public — страница оператора; закрыта или без адреса — имя текстом (13.10). */
  operator_slug: string | null;
  operator_public: boolean | null;
}

// Keywords that signal the user wants to find / book something concrete
const INTENT_KEYWORDS = [
  'тур', 'хочу', 'запис', 'брон', 'поездк', 'поехать',
  'рыбалк', 'вулкан', 'экскурс', 'трекк', 'поход', 'медвед',
  'источник', 'вертолёт', 'снегоход', 'морск', 'kayak',
  'fishing', 'trekking', 'helicopter', 'booking', 'tour',
];

/**
 * «тур» и «tour» — только как начало слова и не «турист»/«tourist»: подстрока
 * «тур» сидит в слове «турист», и сообщение «я турист, заблудился» считалось
 * интересом к туру (разбор 24.09). «туры», «турбаза», «турагентство» — по-прежнему да.
 */
const WORD_START_KEYWORDS: Record<string, RegExp> = {
  'тур': /(?<![а-яё])тур(?!ист)/,
  'tour': /(?<![a-z])tour(?!ist)/,
};

/**
 * «Что посмотреть за 5 дней?» не содержит слова «тур», и карточки каталога
 * к ответу не подмешивались. Это вопрос к витрине, даже без вида занятия.
 * Голое «посмотреть» и «за N дней» — не вопрос: «посмотреть погоду» и
 * «за 3 дня до вылета» туры не тянут.
 */
const SIGHTSEEING = /что\s+посмотреть|посмотреть\s+за\s+\d{1,2}\s+дн|что\s+увидеть|куда\s+(?:сходить|съездить)/;

export function isSightseeingQuestion(text: string): boolean {
  return SIGHTSEEING.test(text.toLowerCase().replace(/ё/g, 'е'));
}

/** Аренда машины без водителя. «Хочу» само по себе туром не делает этот вопрос. */
export function isCarRentalAsk(text: string): boolean {
  const lower = text.toLowerCase().replace(/ё/g, 'е');
  // «турист» — не упоминание тура: тот же запрет (?!ист), что у интереса к туру.
  return /аренд|прокат/.test(lower) && /авто|машин|автомобил/.test(lower) && !/(?<![а-яе])тур(?!ист)/.test(lower);
}

/**
 * Карточки каталога под ответом. «Хочу арендовать авто» их не получает:
 * слово «хочу» есть в признаках тура, а витрина туров тут ни при чём.
 */
export function wantsTourCards(text: string): boolean {
  if (isCarRentalAsk(text)) return false;
  const intent = detectTourIntent(text);
  if (!intent.detected) return false;
  if (intent.activityType || isSightseeingQuestion(text)) return true;
  const lower = text.toLowerCase().replace(/ё/g, 'е');
  return /(?<![а-яе])тур(?!ист)|поездк|экскурс|поход|трекк|программ/.test(lower);
}

function keywordHit(lower: string, kw: string): boolean {
  const rx = WORD_START_KEYWORDS[kw];
  return rx ? rx.test(lower) : lower.includes(kw);
}

// Maps message tokens → operator_tours.activity_type values
const ACTIVITY_MAP: Record<string, string> = {
  рыбалк: 'fishing',    fishing:    'fishing',
  трекк:  'trekking',   trekking:   'trekking',
  поход:  'trekking',   trek:       'trekking',
  сплав:  'rafting',    rafting:    'rafting',
  река:   'rafting',    river:      'rafting',
  вулкан: 'volcano',    volcano:    'volcano',
  источник:'thermal',   термал:     'thermal',
  медвед: 'bears',      bears:      'bears',
  вертолёт:'helicopter',helicopter: 'helicopter',
  морск:  'boat_trip',  boat:       'boat_trip',
  снегоход:'snowmobile',
};

/** Первое слово словаря видов, встретившееся в тексте: по нему и тип, и поиск в названии. */
function activityKeyword(lower: string): string | null {
  for (const kw of Object.keys(ACTIVITY_MAP)) {
    if (lower.includes(kw)) return kw;
  }
  return null;
}

/** Вид занятия в вопросе. Нет слова из словаря — оба поля пустые, каталог не сужается. */
export function askedActivity(text: string): { type: string | null; word: string | null } {
  const word = activityKeyword(text.toLowerCase());
  return { type: word ? ACTIVITY_MAP[word]! : null, word };
}

// ── Detect booking/tour intent ────────────────────────────────────
export function detectTourIntent(text: string): {
  detected: boolean;
  activityType: string | null;
  rawWords: string;
} {
  const lower = text.toLowerCase();

  const detected = INTENT_KEYWORDS.some((kw) => keywordHit(lower, kw)) || isSightseeingQuestion(text);
  if (!detected) return { detected: false, activityType: null, rawWords: '' };

  const kw = activityKeyword(lower);
  return { detected: true, activityType: kw ? ACTIVITY_MAP[kw]! : null, rawWords: text.slice(0, 200) };
}

// ── Fetch relevant tours from DB ──────────────────────────────────
export async function findRelevantTours(
  activityType: string | null,
  rawText: string,
  limit = 3,
): Promise<TourSuggestion[]> {
  // Кандидатов — с запасом: если в вопросе назван вулкан, туры про чужие
  // вулканы отсеиваются (lib/ai/tour-place-relevance, проба 764), и тур про
  // названный не должен остаться за лимитом в три самых новых.
  const candidates = Math.min(limit * 4, 20);
  try {
    const params: unknown[] = [candidates];
    // Шлюз витрины (lib/tours/public-visibility): снятый с витрины тур —
    // демо, черновик, чужой партнёр — в чат не идёт, как и в каталог.
    const where: string[] = [publicTourSql('ot')];
    let placeFirst = '';

    // Слово туриста — не всегда тип (тот же урок, что у get_tours в
    // lib/kuzmich/tour-filter, 25.09 и 08.10): тип volcano — это восхождение,
    // а «вулкан» в вопросе — любой тур к вулкану, и джип к Горелому, и облёт.
    // Поэтому тип ИЛИ слово в названии тура.
    let typeCond: string | null = null;
    if (activityType) {
      params.push(activityType);
      typeCond = `ot.activity_type = $${params.length}`;
      const word = activityKeyword(rawText.toLowerCase());
      if (word && ACTIVITY_MAP[word] === activityType) {
        params.push(`%${word.replace(/ё/g, 'е')}%`);
        typeCond = `(${typeCond} OR translate(ot.title, 'Ёё', 'Ее') ILIKE $${params.length})`;
      }
    }
    // Названный вулкан приводит туры к нему любого типа (13.10): к Авачинскому
    // ведут джип и снегоход, а слово «вулкан» давало тип volcano — один тур
    // каталога, Ключевской. Тип не сужает туры к месту, а добавляет свои;
    // туры к месту идут первыми, чтобы лимит не срезал их.
    const patterns = volcanoNamePatterns(namedVolcanoes(rawText));
    if (patterns.length > 0) {
      params.push(patterns);
      const placeCond = `translate(concat_ws(' ', ot.title, ot.location_name, ot.description), 'Ёё', 'Ее') ILIKE ANY($${params.length}::text[])`;
      // Без типа отбор и так по всему каталогу — меняется только порядок.
      if (typeCond) where.push(`(${typeCond} OR ${placeCond})`);
      placeFirst = `(${placeCond}) DESC, `;
    } else if (typeCond) {
      where.push(typeCond);
    }

    const result = await pool.query<TourSuggestion>(
      `SELECT
         ot.id, ot.slug,
         ot.title,
         LEFT(ot.description, 120) AS description,
         ot.base_price,
         ot.price_unit, ot.multi_day_count, ot.duration_hours::float AS duration_hours,
         ot.activity_type,
         ot.location_type,
         ot.location_name AS location,
         ot.tour_image,
         p.name AS operator_name,
         p.slug AS operator_slug, p.is_public AS operator_public
       FROM operator_tours ot
       JOIN partners p ON ot.operator_id = p.id
       WHERE ${where.join(' AND ')}
       ORDER BY ${placeFirst}ot.created_at DESC
       LIMIT $1`,
      params,
    );

    // Fallback — no activity match: try keyword search in title
    if (result.rows.length === 0 && rawText) {
      const fallback = await pool.query<TourSuggestion>(
        `SELECT
           ot.id, ot.slug, ot.title,
           LEFT(ot.description, 120) AS description,
           ot.base_price, ot.activity_type,
           ot.price_unit, ot.multi_day_count, ot.duration_hours::float AS duration_hours,
           ot.location_type, ot.location_name AS location, ot.tour_image,
           p.name AS operator_name,
           p.slug AS operator_slug, p.is_public AS operator_public
         FROM operator_tours ot
         JOIN partners p ON ot.operator_id = p.id
         WHERE ${publicTourSql('ot')}
           AND ot.title ILIKE $1
         ORDER BY ot.created_at DESC
         LIMIT $2`,
        [`%${rawText.split(' ').slice(0, 3).join('%')}%`, candidates],
      );
      return pickToursForMessage(rawText, fallback.rows, limit);
    }

    return pickToursForMessage(rawText, result.rows, limit);
  } catch (e) {
    // Подсказки туров необязательны для ответа, но отказ — в лог (§4.0).
    console.error('[booking-intent] подбор туров не выполнен', {
      code: (e as { code?: string })?.code, message: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
}
