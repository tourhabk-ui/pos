/**
 * `search` и `fetch` — пара инструментов, которую требуют коннекторы ChatGPT
 * (ступень 2 агентного контура, решение владельца 12.10 «го, делай ступень 2»).
 *
 * ── Зачем ─────────────────────────────────────────────────────────────────
 *
 * ChatGPT без Developer Mode отвергает MCP-сервер, у которого нет инструментов
 * ровно с именами `search` и `fetch`; deep research зовёт только их. Форма —
 * по документации OpenAI (developers.openai.com/docs/mcp):
 *   search(query)  → { results: [{ id, title, url }] }
 *   fetch(id)      → { id, title, text, url, metadata? }
 * Объект уходит и как structuredContent, и JSON-строкой в content[0].text;
 * цитата у ChatGPT появляется только при непустом `url`.
 *
 * Имена, лимиты и схемы — в lib/mcp/connector-schemas (без базы: их читает
 * реестр, а реестр — страница /mcp, собираемая на сборке без DATABASE_URL).
 * Здесь — исполнение с SQL.
 *
 * ── Что ищется ────────────────────────────────────────────────────────────
 *
 * Четыре публичных источника, каждый под своим гейтом витрины — тем же, что
 * у страниц сайта, чтобы агент не нашёл то, чего турист не видит:
 *   tour  — operator_tours через publicTourSql (lib/tours/public-visibility);
 *   place — places: видимые и не слитые (NOT_MERGED, lib/places/aliases);
 *   stay  — accommodations через publicAccommodationSql (модерация);
 *   route — v_kamchatka_routes_api с is_visible (CLAUDE.md §4: только через
 *           представление).
 * Отбор — по СЛОВАМ запроса, каждое своим параметром ILIKE по названию и
 * описанию (lib/mcp/search-terms: русские основы, английский словарь);
 * запись проходит при совпадении любого слова, ранг — число совпавших слов,
 * затем pg_trgm similarity() по названию (расширение в baseline прода, им же
 * считает сверка мест с OSM). До 12.10 вся строка шла в ILIKE одним куском,
 * и «Курильское озеро медведи» — пример из описания инструмента — на проде
 * отвечал пусто.
 *
 * ── Чего здесь нет ────────────────────────────────────────────────────────
 *
 * Телефонов и почт: ни контактов жилья, ни контактов операторов, ни данных
 * туристов (pd-guard). Выдуманных полей: чего в строке нет — в тексте нет.
 * Опасностей, выведенных шаблоном 070 из типа места: правило одно на
 * платформу (lib/safety/profile-source), и читает это чужой ИИ-клиент, который
 * повторит как факт. Частичных ответов: отказ любого из четырёх источников —
 * отказ всего поиска с SQLSTATE в логе (§4.0), а не «нашлось меньше».
 *
 * Сторож: tests/unit/mcp-chatgpt-connector.test.ts.
 */

import { pool } from '@/lib/db-pool';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { publicAccommodationSql } from '@/lib/stay/moderation';
import { NOT_MERGED } from '@/lib/places/aliases';
import { tourPath } from '@/lib/tours/tour-url';
import { getPublicBaseUrl } from '@/lib/config';
import { containsPattern } from '@/lib/db/like';
import { searchTerms } from '@/lib/mcp/search-terms';
import { logText } from '@/lib/log/log-text';
import { McpUserError } from '@/lib/mcp/jsonrpc';
import { asProfileSource, honestSafetyFields } from '@/lib/safety/profile-source';
import { HAZARDS } from '@/lib/safety/hazard-labels';
import { describeForAgent } from '@/lib/places/description-voice';
import {
  SEARCH_TOOL_NAME, FETCH_TOOL_NAME, CONNECTOR_TOOL_NAMES,
  SEARCH_RESULTS_MAX, QUERY_MIN_CHARS, QUERY_MAX_CHARS, FETCH_TEXT_MAX,
} from '@/lib/mcp/connector-schemas';

export {
  SEARCH_TOOL, FETCH_TOOL, SEARCH_TOOL_NAME, FETCH_TOOL_NAME, CONNECTOR_TOOL_NAMES,
  SEARCH_RESULTS_MAX, QUERY_MIN_CHARS, QUERY_MAX_CHARS, FETCH_TEXT_MAX,
} from '@/lib/mcp/connector-schemas';

export type DocKind = 'tour' | 'place' | 'stay' | 'route';

export interface DocId {
  kind: DocKind;
  key: string;
}

const KINDS: ReadonlySet<string> = new Set(['tour', 'place', 'stay', 'route']);
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;

/** `tour:12`, `place:kurilskoe-ozero`, `stay:<uuid>`, `route:<slug>` → род и ключ; мусор — null. */
export function parseDocId(raw: unknown): DocId | null {
  if (typeof raw !== 'string') return null;
  const m = /^([a-z]+):(.+)$/.exec(raw.trim());
  if (!m || !KINDS.has(m[1]) || !KEY_RE.test(m[2])) return null;
  return { kind: m[1] as DocKind, key: m[2] };
}

export function docId(kind: DocKind, key: string): string {
  return `${kind}:${key}`;
}

export function docUrl(kind: DocKind, key: string, base: string = getPublicBaseUrl()): string {
  const b = base.replace(/\/$/, '');
  switch (kind) {
    case 'tour': return `${b}${tourPath({ id: key })}`;
    case 'place': return `${b}/places/${encodeURIComponent(key)}`;
    case 'stay': return `${b}/accommodations/${encodeURIComponent(key)}`;
    case 'route': return `${b}/routes/${encodeURIComponent(key)}`;
  }
}

export interface SearchResultItem {
  id: string;
  title: string;
  url: string;
}

export interface SearchResult {
  results: SearchResultItem[];
}

interface HitRow {
  key: string;
  title: string;
  score: number | null;
  /** Сколько слов запроса нашлось в записи (название или описание). */
  hits: number | string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readQuery(raw: unknown): string {
  const q = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (q.length < QUERY_MIN_CHARS) {
    throw new McpUserError(`Запрос короче ${QUERY_MIN_CHARS} символов — искать нечего. Передайте слова запроса в поле query.`, 'invalid_args:query');
  }
  if (q.length > QUERY_MAX_CHARS) {
    throw new McpUserError(`Запрос длиннее ${QUERY_MAX_CHARS} символов — сократите его.`, 'invalid_args:query');
  }
  return q;
}

function sqlFailure(source: string, err: unknown): Error {
  const code = (err as { code?: unknown })?.code;
  console.error(`[mcp/search] источник ${source} не прочитан:`, typeof code === 'string' ? `SQLSTATE=${logText(code, 10)}` : '', logText(err instanceof Error ? err.message : err, 200));
  return new Error(`search: источник ${source} не ответил`);
}

/**
 * Условие и ранг по словам запроса. Слова — параметры $2..$(n+1) ($1 занят
 * строкой запроса для similarity). Запись проходит, если ЛЮБОЕ слово есть
 * в любой из колонок; `hits` — сколько слов нашлось. Текст колонок — только
 * литералы отсюда, параметры — только `$n`: конкатенации чужого текста нет.
 */
export function termSql(cols: readonly string[], terms: number): { where: string; hits: string } {
  if (terms < 1) throw new Error('termSql: нужно хотя бы одно слово');
  const perTerm = Array.from({ length: terms }, (_, i) => {
    const p = `$${i + 2}`;
    return `(${cols.map((c) => `${c} ILIKE ${p}`).join(' OR ')})`;
  });
  return {
    where: perTerm.join(' OR '),
    hits: perTerm.map((t) => `(${t})::int`).join(' + '),
  };
}

/** Четыре запроса поиска для `terms` слов — одно место, которое читают и исполнение, и pg-тест. */
export function searchSql(terms: number): Record<DocKind, string> {
  const tour = termSql(['ot.title', "COALESCE(ot.short_description, '')", "COALESCE(ot.description, '')", "COALESCE(ot.location_name, '')"], terms);
  const place = termSql(['p.name', "COALESCE(p.description, '')"], terms);
  const stay = termSql(['a.name', "COALESCE(a.description, '')", "COALESCE(a.location_zone, '')"], terms);
  const route = termSql(['r.title', "COALESCE(r.description, '')"], terms);
  return {
    tour: `SELECT ot.id::text AS key, ot.title, similarity(ot.title, $1) AS score, ${tour.hits} AS hits
       FROM operator_tours ot
      WHERE ${publicTourSql('ot')}
        AND (${tour.where})
      ORDER BY hits DESC, similarity(ot.title, $1) DESC, char_length(ot.title) ASC, ot.id ASC
      LIMIT ${SEARCH_RESULTS_MAX}`,
    place: `SELECT COALESCE(p.slug, p.ark_id::text) AS key, p.name AS title, similarity(p.name, $1) AS score, ${place.hits} AS hits
       FROM places p
      WHERE p.is_visible = TRUE AND ${NOT_MERGED('p')}
        AND (${place.where})
      ORDER BY hits DESC, similarity(p.name, $1) DESC, char_length(p.name) ASC, p.name ASC
      LIMIT ${SEARCH_RESULTS_MAX}`,
    stay: `SELECT a.id::text AS key, a.name AS title, similarity(a.name, $1) AS score, ${stay.hits} AS hits
       FROM accommodations a
      WHERE ${publicAccommodationSql('a')}
        AND (${stay.where})
      ORDER BY hits DESC, similarity(a.name, $1) DESC, char_length(a.name) ASC, a.name ASC
      LIMIT ${SEARCH_RESULTS_MAX}`,
    route: `SELECT COALESCE(r.slug, r.ark_id::text, r.id::text) AS key, r.title, similarity(r.title, $1) AS score, ${route.hits} AS hits
       FROM v_kamchatka_routes_api r
      WHERE r.is_visible = TRUE
        AND (${route.where})
      ORDER BY hits DESC, similarity(r.title, $1) DESC, char_length(r.title) ASC, r.title ASC
      LIMIT ${SEARCH_RESULTS_MAX}`,
  };
}

/** Параметры к searchSql: строка запроса для similarity и шаблон ILIKE на каждое слово. */
export function searchParams(query: string): string[] {
  return [query, ...searchTerms(query).map(containsPattern)];
}

/**
 * Поиск по четырём источникам разом. Каждый источник — свой запрос под своим
 * гейтом; слияние — по числу совпавших слов, затем по similarity названия,
 * при равенстве — короткое имя первым.
 */
export async function searchDocuments(rawQuery: unknown, base: string = getPublicBaseUrl()): Promise<SearchResult> {
  const q = readQuery(rawQuery);
  const params = searchParams(q);
  const sql = searchSql(params.length - 1);

  const tours = pool.query<HitRow>(sql.tour, params).catch((err: unknown) => { throw sqlFailure('tours', err); });
  const places = pool.query<HitRow>(sql.place, params).catch((err: unknown) => { throw sqlFailure('places', err); });
  const stays = pool.query<HitRow>(sql.stay, params).catch((err: unknown) => { throw sqlFailure('stays', err); });
  const routes = pool.query<HitRow>(sql.route, params).catch((err: unknown) => { throw sqlFailure('routes', err); });

  const [t, p, s, r] = await Promise.all([tours, places, stays, routes]);
  const hits: Array<HitRow & { kind: DocKind }> = [
    ...t.rows.map((x) => ({ ...x, kind: 'tour' as const })),
    ...p.rows.map((x) => ({ ...x, kind: 'place' as const })),
    ...s.rows.map((x) => ({ ...x, kind: 'stay' as const })),
    ...r.rows.map((x) => ({ ...x, kind: 'route' as const })),
  ];
  hits.sort((a, b) =>
    (Number(b.hits ?? 0) - Number(a.hits ?? 0))
    || (Number(b.score ?? 0) - Number(a.score ?? 0))
    || a.title.length - b.title.length
    || a.title.localeCompare(b.title, 'ru'));
  return {
    results: hits.slice(0, SEARCH_RESULTS_MAX).map((h) => ({
      id: docId(h.kind, h.key),
      title: h.title,
      url: docUrl(h.kind, h.key, base),
    })),
  };
}

export interface FetchResult {
  id: string;
  title: string;
  text: string;
  url: string;
  metadata: Record<string, unknown>;
}

function line(label: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.length ? `${label}: ${value.map(String).join('; ')}` : null;
  const s = String(value).trim();
  return s ? `${label}: ${s}` : null;
}

function joinLines(parts: Array<string | null>): string {
  return parts.filter((x): x is string => Boolean(x)).join('\n').slice(0, FETCH_TEXT_MAX);
}

function notFound(id: string): McpUserError {
  return new McpUserError(`Записи ${id} нет среди опубликованных — возможно, она снята с витрины. Повторите search.`, 'not_found');
}

interface TourRow {
  id: string; title: string; slug: string | null; short_description: string | null; description: string | null;
  base_price: string | null; currency: string | null; price_unit: string | null; duration_hours: string | null;
  duration_type: string | null; multi_day_count: number | null; difficulty: string | null;
  season_start: string | null; season_end: string | null; location_name: string | null;
  included: string[] | null; not_included: string[] | null; what_to_bring: string[] | null; safety_notes: string[] | null;
  program: Array<{ title?: string; text?: string }> | null; price_note: string | null; cancellation_policy: string | null;
  operator_name: string | null;
}

async function fetchTour(key: string, base: string): Promise<FetchResult> {
  const id = docId('tour', key);
  if (!/^\d{1,15}$/.test(key)) throw notFound(id);
  const { rows: [t] } = await pool.query<TourRow>(
    `SELECT ot.id::text AS id, ot.title, ot.slug, ot.short_description, ot.description,
            ot.base_price::text AS base_price, ot.currency, ot.price_unit, ot.duration_hours::text AS duration_hours,
            ot.duration_type, ot.multi_day_count, ot.difficulty,
            ot.season_start::text AS season_start, ot.season_end::text AS season_end, ot.location_name,
            ot.included, ot.not_included, ot.what_to_bring, ot.safety_notes, ot.program, ot.price_note,
            ot.cancellation_policy, p.name AS operator_name
       FROM operator_tours ot
       LEFT JOIN partners p ON p.id::text = ot.operator_id::text
      WHERE ot.id = $1::bigint AND ${publicTourSql('ot')}
      LIMIT 1`,
    [key],
  );
  if (!t) throw notFound(id);
  const program = Array.isArray(t.program)
    ? t.program.map((s, i) => `${i + 1}. ${[s.title, s.text].filter(Boolean).join(' — ')}`).join('\n')
    : null;
  const price = t.base_price ? `${Math.round(Number(t.base_price))} ${t.currency ?? 'RUB'}${t.price_unit === 'per_person' ? ' за человека' : ''}` : null;
  const duration = t.duration_type === 'multi_day' && t.multi_day_count ? `${t.multi_day_count} дн.` : (t.duration_hours ? `${Number(t.duration_hours)} ч` : null);
  const text = joinLines([
    `Тур «${t.title}»${t.operator_name ? ` — оператор ${t.operator_name}` : ''}.`,
    line('Место', t.location_name),
    line('Цена', price),
    line('Длительность', duration),
    line('Сложность', t.difficulty),
    t.season_start && t.season_end ? `Сезон: ${t.season_start} — ${t.season_end}` : null,
    t.short_description,
    t.description,
    program ? `Программа:\n${program}` : null,
    line('Включено', t.included),
    line('Не включено', t.not_included),
    line('Что взять с собой', t.what_to_bring),
    line('Безопасность', t.safety_notes),
    line('Условия отмены', t.cancellation_policy),
    line('Примечание к цене', t.price_note),
    'Заявка на тур подтверждается оператором; оплата — напрямую оператору.',
  ]);
  return {
    id,
    title: t.title,
    text,
    url: `${base.replace(/\/$/, '')}${tourPath({ id: t.id, slug: t.slug })}`,
    metadata: { kind: 'tour', price: t.base_price ? Number(t.base_price) : null, currency: t.currency, duration, season_start: t.season_start, season_end: t.season_end, operator: t.operator_name },
  };
}

interface PlaceRow {
  key: string; name: string; description: string | null; essence: string | null; location_type: string | null;
  category: string | null; district: string | null; lat: string | null; lng: string | null; best_season: string | null;
  access_info: string | null; eco_permit_required: boolean | null;
  hazard_types: string[] | null; profile_source: string | null; nearest_medical_km: string | null;
}

/**
 * Опасности места словами — только те, что не выведены шаблоном 070 из типа
 * места: правило одно на платформу (lib/safety/profile-source, миграция
 * 1100). Код без подписи в словаре (HAZARDS) не произносится — та же
 * практика, что у карточки места для Кузьмича (lib/kuzmich/place-info-tool).
 */
function honestHazards(p: Pick<PlaceRow, 'hazard_types' | 'profile_source'>): string[] {
  const kept = honestSafetyFields(
    { hazardTypes: p.hazard_types ?? [], capacityPerDay: null, optimalGroupSize: null, difficultyLevel: null, terrainType: null },
    asProfileSource(p.profile_source),
  ).hazardTypes;
  return [...new Set(kept.map((h) => HAZARDS[h]?.label?.toLocaleLowerCase('ru-RU')).filter((h): h is string => Boolean(h)))];
}

/** fetch обещает полный текст записи: описание не режется, только судится голос. */
const FETCH_DESCRIPTION_MAX = 20_000;

async function fetchPlace(key: string, base: string): Promise<FetchResult> {
  const id = docId('place', key);
  const { rows: [p] } = await pool.query<PlaceRow>(
    `SELECT COALESCE(p.slug, p.ark_id::text) AS key, p.name, p.description, p.essence, p.location_type, p.category,
            p.district, p.lat::text AS lat, p.lng::text AS lng, p.best_season, p.access_info, p.eco_permit_required,
            lsp.hazard_types, lsp.profile_source, lsp.nearest_medical_km::text AS nearest_medical_km
       FROM places p
       LEFT JOIN location_safety_profile lsp ON lsp.agent_route_id = p.ark_id
      WHERE p.is_visible = TRUE AND ${NOT_MERGED('p')}
        AND (p.slug = $1 OR p.ark_id::text = $1)
      ORDER BY (p.slug = $1) DESC
      LIMIT 1`,
    [key],
  );
  if (!p) throw notFound(id);
  const hazards = honestHazards(p);
  const text = joinLines([
    `${p.name}${p.location_type ? ` (${p.location_type})` : ''}${p.district ? `, ${p.district}` : ''}.`,
    p.lat && p.lng ? `Координаты: ${Number(p.lat).toFixed(5)}, ${Number(p.lng).toFixed(5)}` : null,
    p.essence,
    // Голос описания — тем же правилом, что у get_place_info и
    // get_guardian_context (14.10): fetch отдавал текст как есть, и описание,
    // написанное путевой заметкой («я стою у подножия», «идёшь не меньше
    // недели»), уходило внешнему агенту фактом. Длина — без обрезки: fetch
    // обещает полный текст.
    describeForAgent(p.description, FETCH_DESCRIPTION_MAX),
    line('Лучший сезон', p.best_season),
    line('Как добраться', p.access_info),
    p.eco_permit_required ? 'Нужно разрешение на посещение (ООПТ).' : null,
    line('Опасности', hazards),
    p.nearest_medical_km ? `До медпомощи: ${Number(p.nearest_medical_km)} км` : null,
    'Экстренный вызов на Камчатке — 112. Обстановка сейчас: инструмент get_guardian_context.',
  ]);
  return {
    id: docId('place', p.key),
    title: p.name,
    text,
    url: docUrl('place', p.key, base),
    metadata: { kind: 'place', location_type: p.location_type, lat: p.lat ? Number(p.lat) : null, lng: p.lng ? Number(p.lng) : null, hazards },
  };
}

interface StayRow {
  id: string; name: string; type: string | null; description: string | null; short_description: string | null;
  location_zone: string | null; price_from: string | null; price_to: string | null; currency: string | null;
  amenities: unknown; cancellation_policy: string | null; external_booking_url: string | null;
}

async function fetchStay(key: string, base: string): Promise<FetchResult> {
  const id = docId('stay', key);
  if (!UUID_RE.test(key)) throw notFound(id);
  const { rows: [a] } = await pool.query<StayRow>(
    `SELECT a.id::text AS id, a.name, a.type, a.description, a.short_description, a.location_zone,
            a.price_per_night_from::text AS price_from, a.price_per_night_to::text AS price_to, a.currency,
            a.amenities, a.cancellation_policy, a.external_booking_url
       FROM accommodations a
      WHERE a.id = $1::uuid AND ${publicAccommodationSql('a')}
      LIMIT 1`,
    [key],
  );
  if (!a) throw notFound(id);
  const amenities = Array.isArray(a.amenities) ? a.amenities.map(String) : null;
  const price = a.price_from
    ? `от ${Math.round(Number(a.price_from))}${a.price_to ? ` до ${Math.round(Number(a.price_to))}` : ''} ${a.currency ?? 'RUB'} за ночь`
    : null;
  const text = joinLines([
    `Жильё «${a.name}»${a.type ? ` (${a.type})` : ''}${a.location_zone ? `, ${a.location_zone}` : ''}.`,
    line('Цена', price),
    a.short_description,
    a.description,
    line('Удобства', amenities),
    line('Условия отмены', a.cancellation_policy),
    a.external_booking_url ? 'Бронь и свободные даты — на сайте объекта, ссылка на карточке.' : 'Заявку на даты подтверждает владелец; расчёт — напрямую с ним. Контакты — на карточке.',
  ]);
  return {
    id,
    title: a.name,
    text,
    url: docUrl('stay', a.id, base),
    metadata: { kind: 'stay', type: a.type, zone: a.location_zone, price_from: a.price_from ? Number(a.price_from) : null, currency: a.currency },
  };
}

interface RouteRow {
  key: string; title: string; description: string | null; difficulty: string | null; distance_km: string | null;
  duration_hours: string | null; duration_days: number | null; elevation_gain_m: number | null; season: string | null;
  route_type: string | null; hazards: string[] | null; equipment: string[] | null; mchs_registration_required: boolean | null;
  park_name: string | null; zone: string | null;
}

async function fetchRoute(key: string, base: string): Promise<FetchResult> {
  const id = docId('route', key);
  const { rows: [r] } = await pool.query<RouteRow>(
    `SELECT COALESCE(r.slug, r.ark_id::text, r.id::text) AS key, r.title, r.description, r.difficulty,
            r.distance_km::text AS distance_km, r.duration_hours::text AS duration_hours, r.duration_days,
            r.elevation_gain_m, r.season, r.route_type, r.hazards, r.equipment, r.mchs_registration_required,
            r.park_name, r.zone
       FROM v_kamchatka_routes_api r
      WHERE r.is_visible = TRUE
        AND (r.slug = $1 OR r.ark_id::text = $1 OR r.id::text = $1)
      ORDER BY (r.slug = $1) DESC
      LIMIT 1`,
    [key],
  );
  if (!r) throw notFound(id);
  const text = joinLines([
    `Маршрут «${r.title}»${r.zone ? `, ${r.zone}` : ''}.`,
    line('Тип', r.route_type),
    line('Сложность', r.difficulty),
    r.distance_km ? `Дистанция: ${Number(r.distance_km)} км` : null,
    r.duration_days ? `Длительность: ${r.duration_days} дн.` : (r.duration_hours ? `Длительность: ${Number(r.duration_hours)} ч` : null),
    r.elevation_gain_m ? `Набор высоты: ${r.elevation_gain_m} м` : null,
    line('Сезон', r.season),
    r.description,
    line('Опасности', r.hazards),
    line('Снаряжение', r.equipment),
    r.mchs_registration_required ? 'Требуется регистрация в МЧС перед выходом.' : null,
    // Род не утверждается (14.10): park_name — и памятник природы, и национальный парк.
    line('Охраняемая территория', r.park_name),
    'Экстренный вызов на Камчатке — 112.',
  ]);
  return {
    id: docId('route', r.key),
    title: r.title,
    text,
    url: docUrl('route', r.key, base),
    metadata: { kind: 'route', difficulty: r.difficulty, distance_km: r.distance_km ? Number(r.distance_km) : null, season: r.season, mchs_registration_required: r.mchs_registration_required ?? null },
  };
}

export async function fetchDocument(rawId: unknown, base: string = getPublicBaseUrl()): Promise<FetchResult> {
  const parsed = parseDocId(rawId);
  if (!parsed) {
    throw new McpUserError('Поле id должно быть идентификатором из search: tour:<id>, place:<slug>, stay:<uuid> или route:<slug>.', 'invalid_args:id');
  }
  // Отказ базы — сбой, не «не найдено» (§4.0): исключение уходит наверх с
  // SQLSTATE в логе, а не превращается в «записи нет».
  try {
    switch (parsed.kind) {
      case 'tour': return await fetchTour(parsed.key, base);
      case 'place': return await fetchPlace(parsed.key, base);
      case 'stay': return await fetchStay(parsed.key, base);
      case 'route': return await fetchRoute(parsed.key, base);
    }
  } catch (err) {
    if (err instanceof McpUserError) throw err;
    throw sqlFailure(parsed.kind, err);
  }
}

/** Исполнение для MCP-роута: текст — JSON-строка того же объекта, что уходит structuredContent. */
export async function runConnectorTool(name: string, rawArgs: Record<string, unknown>): Promise<string> {
  if (name === SEARCH_TOOL_NAME) return JSON.stringify(await searchDocuments(rawArgs.query));
  if (name === FETCH_TOOL_NAME) return JSON.stringify(await fetchDocument(rawArgs.id));
  throw new McpUserError(`Инструмент ${logText(name, 40)} не из пары search/fetch`, 'unknown_tool');
}
