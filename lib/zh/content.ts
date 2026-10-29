/**
 * Китайские страницы туров и мест — данные (аудит 15.10, CN-pages).
 *
 * Один модуль на всех читателей перевода: страницы /zh/tours/[slug] и
 * /zh/places/[slug], крон перевода /api/cron/zh-translate, sitemap и пинг
 * IndexNow (через lib/zh/pages), hreflang русских карточек. Правило «кто
 * получает китайскую страницу» записано здесь один раз — иначе sitemap,
 * крон и страница разошлись бы при первой правке.
 *
 *   туры  — живые, под шлюзом витрины (publicTourSql) и со строкой партнёра:
 *           то же условие, что у каталога, sitemap и /zh;
 *   места — видимые и не слитые, через которые проходит маршрут хотя бы
 *           одного живого тура (связь — точка пути любого рода, кроме
 *           «рядом», как isPathPoint в lib/routes/link-kind), или названные
 *           главным местом живого тура (operator_tours.main_place_id, 1286) —
 *           те же две связи, что у «Туры сюда» на карточке места. Правило
 *           названо на странице места (ZH_PLACES_RULE).
 *
 * Тур индексируется всегда, пока он живой: китайская страница — факты из
 * базы (цена, длительность, сезон, группа) китайскими подписями. Проза
 * оператора по-китайски только из свежего перевода и с пометкой машинного;
 * нет перевода — русский текст на страницу не кладётся, есть ссылка на
 * русскую карточку. Место индексируется только со свежим переводом описания:
 * без него страница была бы русским текстом под китайским адресом.
 *
 * Отказ базы — исключение или null с SQLSTATE в логе, а не пустой список
 * (§4.0): «переводы не прочитались» ≠ «переводов нет».
 */

import { pool } from '@/lib/db-pool';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { parseTourParam } from '@/lib/tours/tour-url';
import { asProfileSource, mayStateAsFact } from '@/lib/safety/profile-source';
import { logText } from '@/lib/log/log-text';
import { decodePathParam, zhPlacePath, zhTourPath } from '@/lib/zh/pages';
import {
  ZH_LANG, ZH_PLACE_FIELDS, readField,
  type ZhEntityType, type ZhStoredTranslation,
} from '@/lib/zh/fields';

/**
 * Правило отбора мест — словами для страницы (§0: правило называется на самой
 * витрине): места, через которые проходит маршрут тура в продаже, и главные
 * места туров в продаже (аудит 15.10, TOUR-PLACE).
 */
export const ZH_PLACES_RULE = '收录规则：平台在售团队游路线经过的地点，以及在售团队游的主要目的地。';

/** Причина отказа — в лог именем шага и SQLSTATE (§4.0). */
export function logZhFailure(step: string, err: unknown): void {
  const code = (err as { code?: unknown } | null)?.code;
  console.error(
    `[zh-content] ${step}: не прочитано`,
    typeof code === 'string' ? `SQLSTATE=${logText(code, 10)}` : '',
    logText(err instanceof Error ? err.message : err, 200),
  );
}

// ── Отбор ───────────────────────────────────────────────────────────────

/**
 * SQL-условие «место получает китайскую страницу». Алиас — имя таблицы places
 * в запросе; задаёт код, не пользователь, и всё же проверяется.
 */
export function zhPlaceRuleSql(alias = 'p'): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error(`zhPlaceRuleSql: недопустимый алиас «${alias}»`);
  // «Не слито» — тот же предикат, что NOT_MERGED в lib/places/aliases; здесь
  // строкой, чтобы условие собиралось без импорта модуля псевдонимов (его
  // подменяют сторожа карточки места, а hreflang карточки зовёт этот модуль).
  //
  // Связей две, как у «Туры сюда» (аудит 15.10, TOUR-PLACE): у туров,
  // заведённых миграциями, route_id пуст, и одна цепочка через маршрут давала
  // на проде ноль мест при 37 живых турах. Вторая — главное место тура
  // (main_place_id, 1286). EXISTS, а не JOIN: место не множится по турам.
  return `(${alias}.is_visible = TRUE AND ${alias}.merged_into_id IS NULL AND (EXISTS (
    SELECT 1 FROM route_waypoints rw_zh
      JOIN kamchatka_routes kr_zh ON kr_zh.id = rw_zh.route_id AND kr_zh.merged_into_id IS NULL
      JOIN operator_tours ot_zh ON ot_zh.route_id = kr_zh.id
      JOIN partners pa_zh ON pa_zh.id = ot_zh.operator_id
     WHERE rw_zh.place_id = ${alias}.id
       AND COALESCE(to_jsonb(rw_zh)->>'link_kind', 'unknown') <> 'nearby'
       AND ${publicTourSql('ot_zh')}
  ) OR EXISTS (
    SELECT 1 FROM operator_tours ot_zm
      JOIN partners pa_zm ON pa_zm.id = ot_zm.operator_id
     WHERE ot_zm.main_place_id = ${alias}.id
       AND ${publicTourSql('ot_zm')}
  )))`;
}

// ── Переводы ────────────────────────────────────────────────────────────

export type ZhTranslationMap = Map<string, Map<string, ZhStoredTranslation>>;

/** Переводы сущностей по id → по полю. Бросает при отказе базы. */
export async function loadTranslations(entityType: ZhEntityType, ids: readonly string[]): Promise<ZhTranslationMap> {
  const out: ZhTranslationMap = new Map();
  if (ids.length === 0) return out;
  const { rows } = await pool.query<ZhStoredTranslation & { entity_id: string }>(
    `SELECT entity_id, field, text, source_hash, translated_at, reviewed_at
       FROM content_translations
      WHERE entity_type = $1 AND lang = $2 AND entity_id = ANY($3::text[])`,
    [entityType, ZH_LANG, [...ids]],
  );
  for (const r of rows) {
    const byField = out.get(r.entity_id) ?? new Map<string, ZhStoredTranslation>();
    byField.set(r.field, r);
    out.set(r.entity_id, byField);
  }
  return out;
}

/** Переводы одной сущности; null — не прочитались (лог с причиной). */
async function translationsOf(entityType: ZhEntityType, id: string, step: string): Promise<Map<string, ZhStoredTranslation> | null> {
  try {
    return (await loadTranslations(entityType, [id])).get(id) ?? new Map();
  } catch (err) {
    logZhFailure(step, err);
    return null;
  }
}

// ── Туры ────────────────────────────────────────────────────────────────

/** Строка тура для китайской страницы и крона: тексты для перевода и факты из базы. */
export interface ZhTourSourceRow {
  id: string;
  slug: string | null;
  title: string;
  short_description: string | null;
  description: string | null;
  program: unknown;
  included: string[] | null;
  not_included: string[] | null;
  what_to_bring: string[] | null;
  base_price: string | null;
  price_unit: string | null;
  duration_hours: string | null;
  max_participants: number | null;
  /** Группа тура не ограничена (1342); нет поля — FALSE. */
  group_size_unlimited?: boolean | null;
  /** DATE текстом 'YYYY-MM-DD' — без перевода часовых поясов драйвером. */
  season_start: string | null;
  season_end: string | null;
  safety_notes: string[] | null;
  operator_name: string;
  operator_slug: string | null;
  operator_public: boolean | null;
}

const TOUR_SELECT = `
  SELECT ot.id::text AS id, ot.slug, ot.title, ot.short_description, ot.description,
         ot.program, ot.included, ot.not_included, ot.what_to_bring,
         ot.base_price::text AS base_price, ot.price_unit, ot.duration_hours::text AS duration_hours,
         ot.max_participants, ot.group_size_unlimited, ot.season_start::text AS season_start, ot.season_end::text AS season_end,
         ot.safety_notes,
         p.name AS operator_name, p.slug AS operator_slug, p.is_public AS operator_public
    FROM operator_tours ot
    JOIN partners p ON ot.operator_id = p.id
   WHERE ${publicTourSql('ot')}`;

/** Все живые туры с текстами — для крона и sitemap. Бросает при отказе базы. */
export async function loadZhTourSources(): Promise<ZhTourSourceRow[]> {
  const { rows } = await pool.query<ZhTourSourceRow>(`${TOUR_SELECT} ORDER BY ot.id`);
  return rows;
}

/**
 * Живой тур индексируется: китайская страница фактов не ждёт перевода прозы.
 * Аргументы оставлены, чтобы вызов не разъехался с местом, где свежесть ещё
 * решает (zhPlaceIndexable).
 */
export function zhTourIndexable(
  _t: Pick<ZhTourSourceRow, 'title' | 'description'>,
  _rows: ReadonlyMap<string, ZhStoredTranslation> | null,
): boolean {
  return true;
}

export interface ZhTourPageData {
  tour: ZhTourSourceRow;
  /** Переводы по полю; null — не прочитались. */
  translations: Map<string, ZhStoredTranslation> | null;
  /** Пришли по числу, а у тура есть ЧПУ — страница уводит 308 на него. */
  byId: boolean;
}

/** Тур для китайской страницы; null — нет такого живого тура. Бросает при отказе базы. */
export async function loadZhTourPage(raw: string): Promise<ZhTourPageData | null> {
  const p = parseTourParam(raw);
  if (!p) return null;
  const { rows } = p.kind === 'id'
    ? await pool.query<ZhTourSourceRow>(`${TOUR_SELECT} AND ot.id = $1::bigint LIMIT 1`, [p.id])
    : await pool.query<ZhTourSourceRow>(`${TOUR_SELECT} AND ot.slug = $1 LIMIT 1`, [p.slug]);
  const tour = rows[0];
  if (!tour) return null;
  const translations = await translationsOf('tour', tour.id, 'переводы тура');
  return { tour, translations, byId: p.kind === 'id' };
}

/**
 * hreflang русской карточки тура. Китайская страница есть у каждого живого
 * тура (факты из базы), поэтому пара не зависит от перевода прозы и от того,
 * прочиталась ли таблица переводов.
 */
export async function zhTourAlternatePath(t: { id: string | number; slug?: string | null }): Promise<string> {
  return zhTourPath(t);
}

// ── Места ───────────────────────────────────────────────────────────────

export interface ZhPlaceSourceRow {
  id: string;
  slug: string | null;
  /** Канонический адрес русской карточки без ЧПУ (ruPlacePath). */
  ark_id: string | null;
  name: string;
  description: string | null;
  lat: string | null;
  lng: string | null;
  altitude_m: number | null;
  hazard_types: string[] | null;
  profile_source: string | null;
}

const PLACE_SELECT = `
  SELECT p.id, p.slug, p.ark_id::text AS ark_id, p.name, p.description, p.lat::text AS lat, p.lng::text AS lng,
         sp.altitude_m, sp.hazard_types, sp.profile_source
    FROM places p
    LEFT JOIN location_safety_profile sp ON sp.agent_route_id = p.ark_id
   WHERE ${zhPlaceRuleSql('p')}`;

/**
 * Опасности из шаблона 070/0645 фактом не произносятся (lib/safety/profile-source):
 * доказанный шаблон уходит со строки ещё здесь, у границы данных, — до страницы
 * и до любого будущего читателя китайского конспекта.
 */
function honestPlace(row: ZhPlaceSourceRow): ZhPlaceSourceRow {
  return mayStateAsFact(asProfileSource(row.profile_source)) ? row : { ...row, hazard_types: [] };
}

/** Все места по правилу — для крона и sitemap. Бросает при отказе базы. */
export async function loadZhPlaceSources(): Promise<ZhPlaceSourceRow[]> {
  const { rows } = await pool.query<ZhPlaceSourceRow>(`${PLACE_SELECT} ORDER BY p.id`);
  return rows.map(honestPlace);
}

/** Индексируема ли страница места: описание есть и переведено с нынешнего текста. */
export function zhPlaceIndexable(p: Pick<ZhPlaceSourceRow, 'description'>, rows: ReadonlyMap<string, ZhStoredTranslation> | null): boolean {
  return readField(ZH_PLACE_FIELDS.description, p.description, rows, 'description').state === 'fresh';
}

/** Китайское имя места — только из источника, с его названием. */
export interface ZhPlaceName { name: string; source: string }

const HAN = /\p{Script=Han}/u;

/**
 * Китайское имя — из place_aliases, источник которого назван как OSM name:zh
 * (так его записывают миграции, например 1240). Модель имён не придумывает и
 * транслитерации не сочиняет: нет такой записи — null, и страница пишет
 * русское имя с пометкой.
 */
export async function loadZhPlaceName(placeId: string): Promise<ZhPlaceName | null> {
  try {
    const { rows } = await pool.query<{ alias: string; source_name: string | null }>(
      `SELECT alias, source_name FROM place_aliases
        WHERE place_id = $1 AND source_name ILIKE '%name:zh%'
        ORDER BY created_at, alias`,
      [placeId],
    );
    const hit = rows.find((r) => HAN.test(r.alias));
    return hit ? { name: hit.alias.trim(), source: (hit.source_name ?? '').trim() } : null;
  } catch (err) {
    logZhFailure('китайское имя места', err);
    return null;
  }
}

export interface ZhPlacePageData {
  place: ZhPlaceSourceRow;
  zhName: ZhPlaceName | null;
  translations: Map<string, ZhStoredTranslation> | null;
}

/** Место для китайской страницы по ЧПУ или id; null — не по правилу или нет такого. Бросает при отказе базы. */
export async function loadZhPlacePage(raw: string): Promise<ZhPlacePageData | null> {
  const key = (decodePathParam(raw) ?? '').trim();
  if (!key || key.length > 255) return null;
  const { rows } = await pool.query<ZhPlaceSourceRow>(
    `${PLACE_SELECT} AND (p.slug = $1 OR p.id = $1) ORDER BY (p.slug = $1) DESC LIMIT 1`,
    [key],
  );
  const place = rows[0] ? honestPlace(rows[0]) : null;
  if (!place) return null;
  const [zhName, translations] = await Promise.all([
    loadZhPlaceName(place.id),
    translationsOf('place', place.id, 'переводы места'),
  ]);
  return { place, zhName, translations };
}

/**
 * hreflang русской карточки места: путь китайской страницы, если место по
 * правилу и его описание переведено с нынешнего текста. Одним запросом.
 */
export async function zhPlaceAlternatePath(p: { id: string; slug: string | null; description: string | null }): Promise<string | null> {
  try {
    const { rows } = await pool.query<ZhStoredTranslation>(
      `SELECT ct.field, ct.text, ct.source_hash, ct.translated_at, ct.reviewed_at
         FROM content_translations ct
        WHERE ct.entity_type = 'place' AND ct.lang = $2 AND ct.entity_id = $1
          AND EXISTS (SELECT 1 FROM places p WHERE p.id = $1 AND ${zhPlaceRuleSql('p')})`,
      [p.id, ZH_LANG],
    );
    const byField = new Map(rows.map((r) => [r.field, r]));
    return zhPlaceIndexable(p, byField) ? zhPlacePath(p) : null;
  } catch (err) {
    logZhFailure('hreflang места', err);
    return null;
  }
}

// ── sitemap и IndexNow ──────────────────────────────────────────────────

export interface ZhDetailEntry { path: string; lastModified: Date | null }

function latest(rows: ReadonlyMap<string, ZhStoredTranslation> | undefined): Date | null {
  let max: number | null = null;
  for (const r of rows?.values() ?? []) {
    const t = r.translated_at ? new Date(r.translated_at).getTime() : NaN;
    if (!Number.isNaN(t) && (max === null || t > max)) max = t;
  }
  return max === null ? null : new Date(max);
}

/**
 * Переводы для sitemap не прочитались. Туры уже известны (их страницы —
 * факты, перевод не нужен) и лежат в `tours`. Мест в списке нет: без таблицы
 * нельзя отличить «перевода нет» от «не смог прочитать», и пустой список мест
 * был бы ложью. Вызывающий кладёт туры в sitemap и называет отказ.
 */
export class ZhTranslationsUnread extends Error {
  readonly tours: ZhDetailEntry[];
  constructor(tours: ZhDetailEntry[]) {
    super('переводы китайских страниц не прочитаны');
    this.name = 'ZhTranslationsUnread';
    this.tours = tours;
  }
}

/**
 * Индексируемые китайские страницы: все живые туры и места со свежим
 * переводом описания. Отказ чтения туров или мест — исключение. Отказ
 * чтения переводов — ZhTranslationsUnread с уже прочитанными турами.
 */
export async function loadZhDetailEntries(): Promise<ZhDetailEntry[]> {
  const [tours, places] = await Promise.all([loadZhTourSources(), loadZhPlaceSources()]);
  let tourTr: ZhTranslationMap;
  let placeTr: ZhTranslationMap;
  try {
    [tourTr, placeTr] = await Promise.all([
      loadTranslations('tour', tours.map((t) => t.id)),
      loadTranslations('place', places.map((p) => p.id)),
    ]);
  } catch (err) {
    logZhFailure('переводы для sitemap', err);
    throw new ZhTranslationsUnread(tours.map((t) => ({ path: zhTourPath(t), lastModified: null })));
  }
  const out: ZhDetailEntry[] = [];
  for (const t of tours) {
    const rows = tourTr.get(t.id) ?? new Map();
    if (zhTourIndexable(t, rows)) out.push({ path: zhTourPath(t), lastModified: latest(rows) });
  }
  for (const p of places) {
    const rows = placeTr.get(p.id) ?? new Map();
    if (zhPlaceIndexable(p, rows)) out.push({ path: zhPlacePath(p), lastModified: latest(rows) });
  }
  return out;
}
