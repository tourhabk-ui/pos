/**
 * lib/ai/booking-intent.ts
 *
 * Determines whether a user message contains interest in a tour/activity,
 * then fetches matching tours from DB so the chat can surface them inline.
 */

import { pool } from '@/lib/db-pool';
import { namedVolcanoes, pickToursForMessage, volcanoNamePatterns } from '@/lib/ai/tour-place-relevance';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { nearestFreeDateSql } from '@/lib/tours/nearest-free-date';
import { compareTourOffers, offerOrderDay } from '@/lib/tours/offer-order';
import { namesVehicle } from '@/lib/ai/vehicle-words';

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
  /** Ближайшая дата со свободными местами; ключ порядка (правило 1в). */
  nearest_free_date?: string | null;
  /** Совпало ли с местом, названным в вопросе (релевантность). */
  place_hit?: boolean | null;
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

/**
 * «Аренда», «прокат», «напрокат», «rent a car», «car hire».
 * «Прокатиться», «прокатимся», «прокатят» — глагол поездки, не аренда:
 * «хочу прокатиться на джипе к Мутновскому» — это джип-тур, и пауза проката
 * на него — неверный ответ (ревью 25.10: словарь машин стал шире, и глагол
 * с «джипом» и «вездеходом» начал читаться арендой).
 */
const RENT_WORD = /аренд|прокат(?![ия])|(?<![a-z])(?:rent|hire)/;

/**
 * Аренда машины без водителя. «Хочу» само по себе туром не делает этот вопрос.
 * Вид машины — общий словарь с привязанным чатом партнёра (lib/ai/vehicle-words):
 * «хочу арендовать джип» и «прокат 4x4» — тоже аренда (находка 24.10).
 */
export function isCarRentalAsk(text: string): boolean {
  const lower = text.toLowerCase().replace(/ё/g, 'е');
  // «турист» — не упоминание тура: тот же запрет (?!ист), что у интереса к туру.
  return RENT_WORD.test(lower) && namesVehicle(lower) && !/(?<![а-яе])тур(?!ист)/.test(lower);
}

/**
 * Вопрос о безопасности или обстановке: опасно ли, извержение, пепел, лавина,
 * землетрясение, шторм, погода и ветер, предупреждения МЧС, открыт ли перевал.
 *
 * Карточки и список туров к такому вопросу не прикладываются (находка 24.10):
 * безопасность в ответе стоит выше продажи, и отвечает на неё модель с
 * инструментами обстановки, а не витрина. «Какие опасности на Авачинском
 * вулкане?» получало вместо ответа список туров с ценами.
 * «Водопад Опасный» — имя места, а не вопрос об опасности.
 */
const SAFETY_ASK = new RegExp([
  'опасн',
  'обстановк',
  'изверж',
  'изверга',
  'пепел',
  'пепл',
  'лавин',
  'землетряс',
  'сейсм',
  'цунами',
  'шторм',
  'предупрежден',
  '(?<![а-яе])мчс(?![а-яе])',
  '(?<![а-яе])погод',
  '(?<![а-яе])(?:ветер(?![а-яе])|ветр[а-яе])',
  // «Открыт ли перевал / маршрут / туристическая тропа» — обстановка;
  // «открыты ли туры / места / запись» — вопрос к витрине (ревью 25.10).
  '(?:открыт|закрыт)[аоы]?\\s+ли(?!\\s+(?:еще\\s+)?(?:запис|брон|продаж|тур(?!ист)|экскурс|мест))',
].join('|'));

export function isSafetyOrSituationAsk(text: string): boolean {
  const lower = text.toLowerCase().replace(/ё/g, 'е').replace(/водопад[а-яе]*\s+опасн[а-яе]*/g, ' ');
  return SAFETY_ASK.test(lower);
}

/**
 * Карточки каталога под ответом. «Хочу арендовать авто» их не получает:
 * слово «хочу» есть в признаках тура, а витрина туров тут ни при чём.
 * Вопрос о безопасности и обстановке — тоже нет. Это правило одно на сайт
 * и Telegram (`pickToursForAnswer`, lib/telegram/tourist-tours).
 */
export function wantsTourCards(text: string): boolean {
  if (isCarRentalAsk(text)) return false;
  if (isSafetyOrSituationAsk(text)) return false;
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

/**
 * Порядок подсказок в чате — правило 1в (слово владельца 29.10), а не
 * новизна (до 29.10 — `created_at DESC`, «три самых новых»). Совпадение с
 * названным в вопросе местом — релевантность и идёт первым ключом.
 */
export function suggestionOrder<T extends { id: number | string; nearest_free_date?: string | null; place_hit?: boolean | null }>(
  rows: readonly T[],
  opts?: { day?: string },
): T[] {
  const rule = compareTourOffers(opts?.day ?? offerOrderDay());
  return [...rows].sort((a, b) =>
    (b.place_hit === true ? 1 : 0) - (a.place_hit === true ? 1 : 0)
    || rule({ id: a.id, nearestFreeDate: a.nearest_free_date ?? null }, { id: b.id, nearestFreeDate: b.nearest_free_date ?? null }));
}

// ── Fetch relevant tours from DB ──────────────────────────────────
// Кэш подбора (02.11): в ответе — ближайшая свободная дата, то есть
// доступность. Правило владельца: места живые, кэш не дольше ~30 с;
// ключ — подпись запроса (тип|лимит|текст). Каталог без мест — отдельно (D3).
// Пустой ответ (в т.ч. ошибка базы) не кэшируется.
const TOURS_TTL_MS = 30_000;
const toursCache = new Map<string, { at: number; rows: TourSuggestion[] }>();
// В юнит-тестах база подменяется от теста к тесту — там кэш выключен.
const toursCacheOn = (): boolean => process.env.VITEST !== 'true' || process.env.TOURS_CACHE_TEST === '1';

export async function findRelevantTours(
  activityType: string | null,
  rawText: string,
  limit = 3,
): Promise<TourSuggestion[]> {
  const key = `${activityType ?? ''}|${limit}|${rawText.trim().toLowerCase()}`;
  const hit = toursCacheOn() ? toursCache.get(key) : undefined;
  if (hit && Date.now() - hit.at < TOURS_TTL_MS) return hit.rows;
  const rows = await findRelevantToursUncached(activityType, rawText, limit);
  if (rows.length && toursCacheOn()) {
    if (toursCache.size > 500) toursCache.clear();
    toursCache.set(key, { at: Date.now(), rows });
  }
  return rows;
}

async function findRelevantToursUncached(
  activityType: string | null,
  rawText: string,
  limit = 3,
): Promise<TourSuggestion[]> {
  // Кандидатов — с запасом: если в вопросе назван вулкан, туры про чужие
  // вулканы отсеиваются (lib/ai/tour-place-relevance, проба 764), и тур про
  // названный не должен остаться за лимитом в три самых новых.
  const candidates = Math.min(limit * 4, 20);
  try {
    const params: unknown[] = [];
    // Шлюз витрины (lib/tours/public-visibility): снятый с витрины тур —
    // демо, черновик, чужой партнёр — в чат не идёт, как и в каталог.
    const where: string[] = [publicTourSql('ot')];
    // Совпадение с названным местом — релевантность вопросу, а не порядок
    // витрины: туры к месту идут первыми, внутри — правило 1в.
    let placeHit = 'false';

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
      placeHit = `(${placeCond})`;
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
         p.slug AS operator_slug, p.is_public AS operator_public,
         ${placeHit} AS place_hit,
         ${nearestFreeDateSql('ot')} AS nearest_free_date
       FROM operator_tours ot
       JOIN partners p ON ot.operator_id = p.id
       WHERE ${where.join(' AND ')}`,
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
           p.slug AS operator_slug, p.is_public AS operator_public,
           ${nearestFreeDateSql('ot')} AS nearest_free_date
         FROM operator_tours ot
         JOIN partners p ON ot.operator_id = p.id
         WHERE ${publicTourSql('ot')}
           AND ot.title ILIKE $1`,
        [`%${rawText.split(' ').slice(0, 3).join('%')}%`],
      );
      return pickToursForMessage(rawText, suggestionOrder(fallback.rows).slice(0, candidates), limit);
    }

    return pickToursForMessage(rawText, suggestionOrder(result.rows).slice(0, candidates), limit);
  } catch (e) {
    // Подсказки туров необязательны для ответа, но отказ — в лог (§4.0).
    console.error('[booking-intent] подбор туров не выполнен', {
      code: (e as { code?: string })?.code, message: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
}
