import { pool } from '@/lib/db-pool';
import { isoUtcSql, UTC_WALL_NOW_SQL } from '@/lib/db/timestamp-iso';
import { ACC_META, type AccColor } from '@/lib/services/safety/kvert-vona';
import { kfegsPhrase, kfegsIsFresh, levelForColor, type ScaleColor } from '@/lib/services/safety/volcano-scales';
import { placeTypeLabel } from '@/lib/places/type-label';
import { hazardLabelLower } from '@/lib/safety/hazard-labels';
import { isMarineMammalPlace, marineMammalNote } from '@/lib/safety/marine-mammals';
import { asProfileSource, honestSafetyFields } from '@/lib/safety/profile-source';
import { placeNameOrAliasSearchSql, significantWords, nameContainsAllWordsSql } from '@/lib/places/name-match';
import { describeForAgent } from '@/lib/places/description-voice';
import { containsPattern } from '@/lib/db/like';
import { KUZMICH_KNOWLEDGE_SCOPE_SQL } from '@/lib/kuzmich/knowledge-scope';
import { isVolcanoObservationStale, VOLCANO_STALE_DAYS } from '@/lib/services/safety/kvert-vona';
import { alertOrigin, UNKNOWN_ORIGIN_TEXT } from '@/lib/safety/alert-origin';
import { alertLineForPlace } from '@/lib/kuzmich/alert-mention';
import { loadVolcanoInput, volcanoLinesForName } from '@/lib/kuzmich/volcano-tool';
import { EMERGENCY_PRIMARY } from '@/lib/safety/emergency-numbers';
import { getPublicBaseUrl } from '@/lib/config';
import { placeRoutesFor, placeRoutesLines, type PlaceRouteRow } from '@/lib/places/place-routes';
import { routeFacts } from '@/lib/ai/route-knowledge';
import { garbageSignature } from '@/lib/agents/evo/content-sanitizer';
import { PLACE_STATUS_FRESH_MS, kamchatkaStamp } from '@/lib/safety/place-day-status';
import { KURIL_NORTH_NOTE, isOutsideKraiSources } from '@/lib/safety/kuril-north';

interface GuardianPlaceRow {
  /** id места — для ссылки на его карточку (только в чате, см. pageLinks). */
  id?: string;
  /** Скрытое место: ни координаты, ни ссылки (правило place-info-tool). */
  is_visible?: boolean | null;
  name: string;
  description: string | null;
  location_type: string | null;
  /** Район места: метка Северных Курил значит «вне сводок края» (lib/safety/kuril-north.ts). */
  zone?: string | null;
  lat: number | null;
  lng: number | null;
  hazard_types: string[] | null;
  profile_source: string | null;
  difficulty_level: number | null;
  altitude_m: number | null;
  nearest_medical_km: number | null;
  sat_communicator_required: boolean | null;
  capacity_per_day: number | null;
  open_from_date: string | null;
  open_to_date: string | null;
  is_open: boolean | null;
  current_crowds: number | null;
  active_alerts: string[] | null;
  recommender_status: string | null;
  alert_message: string | null;
  alert_severity: number | null;
  tourists_today: number | null;
  volcano_acc: string | null;
  volcano_ash_height_m: number | null;
  volcano_observed_at: string | null;
  /** Последняя строка сводки КФ ЕГС по этому месту (миграция 1010). */
  kfegs_color: ScaleColor | null;
  kfegs_raw: string | null;
  kfegs_seismicity: string | null;
  kfegs_date: string | null;
  linked_volcanoes: string | null;
  /** Когда статус места пересчитан. null — не записано. */
  status_updated_at?: string | null;
  /** Псевдонимы места (place_aliases) — разговорные имена того же объекта. */
  aliases?: string[] | null;
}

/** Наблюдённый ACC вулкана (unassigned/отсутствие → null — без ложного «спокоен»). */
function accOf(p: GuardianPlaceRow): AccColor | null {
  const c = p.volcano_acc;
  return c === 'green' || c === 'yellow' || c === 'orange' || c === 'red' ? c : null;
}

function accLine(color: AccColor, p: GuardianPlaceRow): string {
  const meta = ACC_META[color];
  const ash = p.volcano_ash_height_m ? ` Пепел до ${(p.volcano_ash_height_m / 1000).toFixed(1)} км.` : '';
  const seen = p.volcano_observed_at
    // По Камчатке, как в get_volcano_status: по часам сервера (UTC)
    // наблюдение утра 25.09 читалось как 24.09 — два инструмента называли
    // одному агенту разные даты одного снимка (сверка 26.09).
    ? ` (наблюдение ${new Date(p.volcano_observed_at).toLocaleDateString('ru-RU', { timeZone: 'Asia/Kamchatka' })})`
    : '';
  // Старое наблюдение называется старым — так же, как в get_volcano_status
  // (kvertPhrase): до 29.09 guardian печатал «ЗЕЛЁНЫЙ — спокоен» по снимку
  // любой давности, и два инструмента давали агенту противоположные выводы
  // о свежести одного снимка (проверка MCP).
  if (isVolcanoObservationStale(p.volcano_observed_at)) {
    return `Авиационный цветовой код KVERT: последнее наблюдение${seen} — ${meta.short.toLowerCase()}, но оно старше ${VOLCANO_STALE_DAYS} дней: текущим его не считать, текущего кода нет.${ash}`;
  }
  return `Авиационный цветовой код KVERT: ${meta.short.toUpperCase()} — ${meta.label.toLowerCase()}.${ash}${seen}`;
}

/**
 * Вторая шкала — сводка КФ ЕГС (24.09). До этого MCP и Кузьмич отвечали про
 * Мутновский «KVERT: ЗЕЛЁНЫЙ — спокоен» при жёлтом у КФ ЕГС (сейсмичность
 * выше фона, сотни событий за сутки): авиационный код — не про тропу.
 *
 * Строки в сводке нет — вулкан ею не охвачен, молчим (как с KVERT). Строка
 * есть, но устарела — говорим, что устарела, а не выдаём старый цвет за
 * текущий и не молчим, будто её не было (§4.0).
 */
function kfegsLine(p: GuardianPlaceRow, nowMs: number = Date.now()): string | null {
  if (!p.kfegs_date || p.kfegs_raw === null) return null;
  if (!kfegsIsFresh(p.kfegs_date, nowMs)) {
    const [, m, d] = p.kfegs_date.split('-');
    return `Сводка КФ ЕГС по вулкану устарела (последняя за ${d}.${m}) — текущего уровня по ней нет.`;
  }
  const phrase = kfegsPhrase({
    color: p.kfegs_color, raw: p.kfegs_raw, seismicity: p.kfegs_seismicity, date: p.kfegs_date,
  });
  // Пояснение — только при повышенном уровне: у зелёного и неразобранного
  // кода «повышенная сейсмичность» была бы неправдой.
  const why = levelForColor(p.kfegs_color)
    ? ' Это не авиационный код: по этой шкале выше зелёного — повышенная сейсмичность и эмиссия газов.'
    : '';
  return `Шкала ${phrase}.${why}`;
}

interface AlertRow {
  title: string;
  severity: number;
  description: string | null;
  source_url: string | null;
  external_id: string | null;
}

interface KnowledgeRow {
  title: string;
  compiled_truth: string;
  type: string;
}

/**
 * Свежесть пересчёта статуса места и время по Камчатке — одно правило с
 * карточкой места (lib/safety/place-day-status.ts, 15.10): карточка и чат
 * отвечают на один вопрос, и порог у них один.
 */
const STATUS_FRESH_MS = PLACE_STATUS_FRESH_MS;

const STATUS_LABEL: Record<string, string> = {
  green: 'ЗЕЛЁНЫЙ',
  yellow: 'ЖЁЛТЫЙ',
  red: 'КРАСНЫЙ',
};


function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[^а-яёa-z0-9\s]/gi, ' ').replace(/\s+/g, ' ').trim();
}

// Паттерны попыток перехвата инструкций модели (issue #328). Пользовательский
// ввод (напр. название места) эхом уходит в контекст для callAIFast/
// callAIWaterfall — маркеры ролей и «забудь инструкции» надо обезвредить ДО
// формирования промпта. Держим RU и EN формы.
const INJECTION_PATTERN_SOURCES: string[] = [
  'ignore\\s+(all\\s+)?(previous|prior|above)\\s+instructions?',
  'disregard\\s+(the\\s+)?(above|previous|prior)',
  'you\\s+are\\s+now\\b',
  'act\\s+as\\s+(an?\\s+)?(system|admin|developer)',
  '</?(system|assistant|user|developer)>',
  '(^|\\s)(system|assistant|developer)\\s*:',
  'забудь\\s+(все\\s+)?(предыдущие|прошлые|прежние)\\s+(инструкции|указания|команды)',
  'игнорируй\\s+(все\\s+)?(предыдущие|прошлые|выше)',
  'ты\\s+теперь\\b',
  'веди\\s+себя\\s+как\\s+(система|админ|разработчик)',
];

const MAX_PROMPT_INPUT_LEN = 200;

/**
 * Обезвреживает пользовательский ввод перед подстановкой в промпт модели:
 * вырезает маркеры ролей и попытки «забудь инструкции», схлопывает пробелы и
 * обрезает по длине. Возвращает очищенный текст и флаг injectionSuspected для
 * логирования. НЕ трогает обычные туристические запросы (в них паттернов нет).
 */
export function sanitizePromptInput(raw: string): { text: string; injectionSuspected: boolean } {
  let text = (typeof raw === 'string' ? raw : '').slice(0, MAX_PROMPT_INPUT_LEN * 4);
  let injectionSuspected = false;

  for (const src of INJECTION_PATTERN_SOURCES) {
    if (new RegExp(src, 'i').test(text)) {
      injectionSuspected = true;
      text = text.replace(new RegExp(src, 'gi'), ' ');
    }
  }

  text = text.replace(/\s+/g, ' ').trim().slice(0, MAX_PROMPT_INPUT_LEN);
  return { text, injectionSuspected };
}

/**
 * CRAG-lite relevance grading (Roitman §16.5.5): ILIKE '%query%' can bind the
 * wrong place — "ORDER BY char_length ASC" prefers the shortest name
 * containing the substring, which for a query like "Толбачик" can surface an
 * unrelated short-named place before the actual volcano. For a safety tool,
 * a confident-looking wrong match is worse than no match: grade the name
 * match before trusting it, so a weak match degrades to an explicit
 * uncertainty note instead of asserting someone else's safety facts.
 */
const MIN_PREFIX_LEN = 3; // короче — тоже "префикс" почти чего угодно (напр. "г." → "гора"/"гейзер")

export function gradeNameMatch(query: string, candidate: string): 'high' | 'low' {
  const q = normalizeForMatch(query);
  const c = normalizeForMatch(candidate);
  if (!q || !c) return 'low';
  if (c === q) return 'high';
  const qWords = q.split(' ').filter(Boolean);
  const cWords = c.split(' ').filter(Boolean);
  const wordMatch = (w: string, t: string) =>
    t === w || (w.length >= MIN_PREFIX_LEN && t.length >= MIN_PREFIX_LEN && (t.startsWith(w) || w.startsWith(t)));
  const covers = (from: string[], to: string[]) =>
    from.every(w => to.some(t => wordMatch(w, t)));
  return (covers(qWords, cWords) || covers(cWords, qWords)) ? 'high' : 'low';
}

/**
 * Совпадение с местом — по названию ИЛИ по его псевдониму (issue #2063).
 * «Ключевской» против «Вулкан Ключевская сопка» — слабое совпадение, и так
 * должно оставаться (морфология рвёт префикс намеренно, см. тесты); но у
 * места записан псевдоним «Ключевской вулкан», и против него запрос сильный.
 * Псевдоним — поимённое решение о ЭТОМ месте, поэтому ему можно верить.
 */
export function gradePlaceMatch(query: string, name: string, aliases?: string[] | null): 'high' | 'low' {
  return [name, ...(aliases ?? [])].some((n) => gradeNameMatch(query, n) === 'high') ? 'high' : 'low';
}

/**
 * Место для ПУБЛИЧНОЙ ссылки (handoff MCP, задача #60): id первой записи по
 * тому же правилу матчинга, что и основной запрос getGuardianContext ниже
 * (merged_into_id IS NULL, ILIKE, кратчайшее имя первым) — чтобы ссылка вела
 * на то место, о котором инструмент ответил. Сверх правила — is_visible:
 * страж может знать скрытое место, но ссылку на невидимую страницу не даём.
 */
export async function resolvePlaceForLink(placeNameRaw: string): Promise<string | null> {
  const q = placeNameRaw.trim();
  if (!q) return null;
  try {
    // Слова, не буквальная фраза (issue #1987): «Горелый вулкан» и «Вулкан
    // Горелый» — один и тот же порядок для человека, разный для ILIKE '%…%'.
    const { clause, params } = placeNameOrAliasSearchSql('p', q, 1);
    const { rows } = await pool.query<{ id: string }>(
      `SELECT p.id FROM places p
        WHERE p.merged_into_id IS NULL AND p.is_visible = true AND (${clause})
        ORDER BY char_length(p.name) ASC
        LIMIT 1`,
      params,
    );
    return rows[0]?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Маршруты места строками для Кузьмича. Без них на «дай маршрут к горе» он
 * отвечал «не оцифрован», хотя на карточке маршрут был (снимок владельца
 * 03.10, «Гора Замок»). Отказ базы — словами, не тишиной (§4.0).
 */
export async function routesLinesForKuzmich(placeId: string): Promise<string[]> {
  return routesLinesFrom(await placeRoutesFor(placeId));
}

/** Те же строки по уже прочитанному списку: null — отказ базы, не «нет». */
function routesLinesFrom(routes: PlaceRouteRow[] | null): string[] {
  if (routes === null) return ['Маршруты этого места проверить не удалось — не говори, что их нет.'];
  if (routes.length === 0) return ['Маршрутов через это место в каталоге нет.'];
  return placeRoutesLines(routes);
}

/**
 * Факты маршрутов к месту — в ответ о безопасности места (14.10).
 *
 * Владелец 14.10: «Кузьмич деградирует». Недельная оценка показала, где
 * именно: pass_rate фикстуры 0.80 (21.09) → 0.65 (05.10, 12.10), вопросы о
 * безопасности 7 из 8 → 3 из 8, и проваливались они одним способом — высоту,
 * сложность, набор высоты, регистрацию в МЧС Кузьмич называл без опоры в
 * данных хода (так их и оценил судья). Не потому, что данных нет: у маршрута
 * «Вулкан Корякский» в базе сложность extreme, 8.4 км, набор 2544 м, в
 * описании — 10–12 часов, лёд, кошки и ледоруб. До Кузьмича это не доходило:
 * этот инструмент знал о маршрутах места только название и длину, а поиск
 * маршрутов по вопросу (lib/ai/route-knowledge) ищет ВЕСЬ вопрос одной
 * подстрокой названия или описания и на живой фразе не находит ничего.
 *
 * Провал совпал по времени с честной правкой 27.09 (миграция 1100):
 * опасности, выведенные шаблоном из типа места, перестали произноситься как
 * факты — и у главных вулканов в ответе стало пусто. Возвращать шаблон
 * нельзя; заполнять пустоту надо тем, что измерено, — маршрутами.
 *
 * Регистрация: утверждением считается только true. false — дефолт колонки
 * (миграция 933), и «не требуется» по нему было бы выдумкой; поэтому, если
 * ни у одного маршрута true не записан, это сказано словами.
 */
export const ROUTE_FACTS_MAX = 4;

/** Строка маршрута для фактов: поля §10 и, у найденных по названию, описание. */
export interface RouteFactsSource {
  id: string;
  title: string;
  difficulty?: string | null;
  distance_km?: string | number | null;
  elevation_gain_m?: number | null;
  duration_hours?: string | number | null;
  season?: string | null;
  hazards?: string[] | null;
  equipment?: string[] | null;
  mchs_registration_required?: boolean | null;
  mchs_phone?: string | null;
  park_name?: string | null;
  description?: string | null;
}

const ROUTE_DESCRIPTION_CHARS = 240;

export function routeFactsLines(routes: RouteFactsSource[]): string[] {
  const seen = new Set<string>();
  const shown: RouteFactsSource[] = [];
  for (const r of routes) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    shown.push(r);
    if (shown.length >= ROUTE_FACTS_MAX) break;
  }
  if (shown.length === 0) return [];

  const asText = (v: string | number | null | undefined): string | null => (v == null ? null : String(v));
  const lines = ['Маршруты каталога к этому месту — данные из базы Ведара:'];
  for (const r of shown) {
    const facts = routeFacts({
      difficulty: r.difficulty ?? null,
      distance_km: asText(r.distance_km),
      elevation_gain_m: r.elevation_gain_m ?? null,
      duration_hours: asText(r.duration_hours),
      season: r.season ?? null,
      hazards: r.hazards ?? null,
      equipment: r.equipment ?? null,
      mchs_registration_required: r.mchs_registration_required ?? null,
      mchs_phone: r.mchs_phone ?? null,
      park_name: r.park_name ?? null,
    });
    // Описание — тем же фильтром голоса, что у мест; сырой JSON модели
    // (санитар контента его ещё не убрал) не цитируется вовсе.
    const desc = r.description && !garbageSignature(r.description)
      ? describeForAgent(r.description, ROUTE_DESCRIPTION_CHARS)
      : null;
    const body = [facts.length ? facts.join('. ') : 'параметры маршрута в базе не записаны', desc]
      .filter(Boolean)
      .join('. ');
    lines.push(`«${r.title}»: ${body}`);
  }
  if (!shown.some((r) => r.mchs_registration_required === true)) {
    lines.push('Регистрация в МЧС по этим маршрутам в базе не записана — это не значит, что она не нужна.');
  }
  return lines;
}

/**
 * Слова, которые сами по себе места не называют: запрос из одних таких
 * («вулкан», «озеро») подобрал бы маршруты наугад.
 */
const GENERIC_PLACE_WORDS: ReadonlySet<string> = new Set([
  'вулкан', 'вулканы', 'озеро', 'гора', 'сопка', 'река', 'бухта', 'долина', 'перевал',
  'водопад', 'пляж', 'мыс', 'источники', 'источник', 'маршрут', 'парк', 'камчатка',
]);

/**
 * Маршруты каталога, в названии которых есть все слова запроса (то же
 * правило слов, что у мест, lib/places/name-match). Маршрут, связанный с
 * местом путевыми точками, находится и без этого — но связи есть не у всех:
 * перепись 23.08 насчитала 131 место без единого живого маршрута (§4.1).
 * null — отказ базы: «не смог посмотреть», а не «маршрутов нет» (§4.0).
 */
async function routesByName(placeName: string): Promise<RouteFactsSource[] | null> {
  const words = significantWords(placeName);
  if (words.length === 0 || words.every((w) => GENERIC_PLACE_WORDS.has(w))) return [];
  const match = nameContainsAllWordsSql('kr.title', words, 1);
  try {
    const { rows } = await pool.query<RouteFactsSource>(
      `SELECT COALESCE(kr.ark_id, kr.id)::text AS id, kr.title, kr.description,
              kr.difficulty, kr.distance_km, kr.elevation_gain_m, kr.duration_hours, kr.season,
              kr.hazards, kr.equipment, kr.mchs_registration_required, kr.mchs_phone, kr.park_name
         FROM kamchatka_routes kr
        WHERE kr.is_visible = TRUE AND kr.merged_into_id IS NULL AND (${match.clause})
        ORDER BY (kr.mchs_registration_required IS TRUE) DESC,
                 (kr.elevation_gain_m IS NOT NULL OR kr.distance_km IS NOT NULL) DESC,
                 kr.search_count DESC NULLS LAST, kr.title
        LIMIT ${ROUTE_FACTS_MAX}`,
      match.params,
    );
    return rows;
  } catch (err) {
    console.error('[guardian] маршруты по названию не прочитаны:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Адрес карточки места на сайте — один для всех ответов Кузьмича. */
export function placePageUrl(placeId: string): string {
  return `${getPublicBaseUrl()}/places/${placeId}`;
}

/**
 * Типы мест, у которых высота — факт безопасности (горная болезнь, снег,
 * погода на вершине). У бухты или музея её отсутствие не новость.
 */
const ALTITUDE_MATTERS: ReadonlySet<string> = new Set(['volcano', 'mountain', 'pass', 'plateau', 'glacier']);

/**
 * Какие числа безопасности у места не записаны — строкой для модели (14.10).
 *
 * Недельная оценка ловила одно и то же: «далеко ли до медпомощи от
 * Толбачика» — у места расстояния нет, а Кузьмич называл число, и от недели
 * к неделе разное. Пустое поле молчало, и модель заполняла его сама — то же
 * «обязательное число выдумывается», что §4.0. Строка называет пробел и
 * запрещает закрывать его памятью; число из данных ниже (факты и описание
 * маршрута) называть можно — это не память.
 */
export function unrecordedSafetyLine(
  p: Pick<GuardianPlaceRow, 'altitude_m' | 'nearest_medical_km' | 'location_type'>,
): string | null {
  const missing = [
    !p.altitude_m && ALTITUDE_MATTERS.has(p.location_type ?? '') ? 'высота' : null,
    !p.nearest_medical_km ? 'расстояние до медпомощи' : null,
  ].filter((x): x is string => x !== null);
  if (missing.length === 0) return null;
  // «Если спросят» — не повод объявлять пробел в каждом ответе: турист,
  // спросивший о виде с вершины, отчёта о незаполненных полях не просил.
  return `В базе не записаны: ${missing.join(', ')}. Если спросят — по памяти числом не называй, ` +
    'скажи, что у Ведара этих цифр нет (число из данных ниже назвать можно).';
}

export interface GuardianContextOptions {
  /**
   * Дописать ссылку на карточку места на сайте (чат Кузьмича). На MCP её не
   * пишем: там своя ссылка «Продолжить в Ведаре» (lib/mcp/handoff-targets).
   */
  pageLinks?: boolean;
}

export async function getGuardianContext(placeNameRaw: string, opts: GuardianContextOptions = {}): Promise<string> {
  // Обезвреживаем ввод до подстановки в промпт (issue #328). Название места
  // и так уходит эхом в hedge-строки контекста для callAIFast/callAIWaterfall.
  // Флаг injectionSuspected доступен через sanitizePromptInput для логирования
  // на уровне вызывающего кода; здесь просто не пропускаем маркеры в промпт.
  const { text: placeName } = sanitizePromptInput(placeNameRaw);
  if (!placeName.trim()) return '';

  // Слова, не буквальная фраза (issue #1986/#1987): ILIKE '%Мутновский
  // вулкан%' не находит «Вулкан Мутновский» (обратный порядок) и вместо
  // отказа молча подставляет случайную запись, СОДЕРЖАЩУЮ ту же подстроку
  // («Скитур на Мутновский вулкан») — без KVERT-строки канонической точки.
  // Сверх слов — псевдонимы места (issue #2063): «Ключевской вулкан» не
  // содержится в «Вулкан Ключевская сопка» ни в каком порядке слов.
  const placeMatch = placeNameOrAliasSearchSql('p', placeName, 1);

  const [placesRes, alertsRes, knowledgeRes, namedRoutes] = await Promise.all([
    pool.query<GuardianPlaceRow>(
      `SELECT
         p.id::text AS id, p.is_visible,
         p.name, p.description, p.location_type, p.lat, p.lng, p.zone,
         lsp.hazard_types, lsp.difficulty_level, lsp.altitude_m, lsp.profile_source,
         lsp.nearest_medical_km, lsp.sat_communicator_required,
         lsp.capacity_per_day, lsp.open_from_date, lsp.open_to_date,
         lrs.is_open, lrs.current_crowds, lrs.active_alerts,
         lrs.recommender_status, lrs.alert_message, lrs.alert_severity,
         ${isoUtcSql('lrs.updated_at')} AS status_updated_at,
         lrs.tourists_today,
         vs.aviation_color_code AS volcano_acc,
         vs.ash_height_m        AS volcano_ash_height_m,
         vs.observed_at         AS volcano_observed_at,
         kb.color               AS kfegs_color,
         kb.color_raw           AS kfegs_raw,
         kb.seismicity          AS kfegs_seismicity,
         kb.observed_date::text AS kfegs_date,
         -- Вулкан, к которому место привязано поимённо (1029): статус места
         -- поднят по его шкалам, и сказать это надо словами, иначе жёлтый у
         -- водопада читается как сбой.
         (SELECT string_agg(v.name, ', ' ORDER BY v.name)
            FROM place_volcano_links l
            JOIN places v ON v.id::text = l.volcano_place_id
           WHERE l.place_id = p.id::text) AS linked_volcanoes,
         (SELECT array_agg(pa.alias ORDER BY pa.alias)
            FROM place_aliases pa
           WHERE pa.place_id = p.id::text) AS aliases
       FROM places p
       LEFT JOIN location_safety_profile lsp ON lsp.agent_route_id = p.ark_id
       LEFT JOIN location_real_time_status lrs ON lrs.agent_route_id = p.ark_id
       LEFT JOIN volcano_status vs ON vs.place_ark_id = p.ark_id
       LEFT JOIN LATERAL (
         SELECT b.color, b.color_raw, b.seismicity, b.observed_date
           FROM volcano_bulletin_kfegs b
          WHERE b.place_ark_id = p.ark_id
          ORDER BY b.observed_date DESC
          LIMIT 1
       ) kb ON TRUE
       WHERE p.merged_into_id IS NULL AND (${placeMatch.clause})
       ORDER BY char_length(p.name) ASC
       LIMIT 3`,
      placeMatch.params,
    ),
    pool.query<AlertRow>(
      `SELECT title, severity, description, source_url, external_id
       FROM external_alerts
       WHERE (expires_at IS NULL OR expires_at > ${UTC_WALL_NOW_SQL})
         AND (title ILIKE $1 OR description ILIKE $1)
       -- Тревоги, названные по месту, — раньше упоминаний в чужих сводках:
       -- иначе три упоминания вытесняли бы тревогу о самом месте (#2699).
       ORDER BY (title ILIKE $1) DESC, severity DESC
       LIMIT 3`,
      [containsPattern(placeName)],
    ),
    pool.query<KnowledgeRow>(
      // Роды — разрешённым списком (lib/kuzmich/knowledge-scope). Запрет одного
      // outcome (проба 113, 15.08) пропускал search_result и auto_gap, у
      // которых заголовок — вопрос туриста дословно: place='+79' отдавал
      // анонимному MCP-клиенту до пяти чужих сообщений (проверка 29.09).
      `SELECT title, compiled_truth, type
       FROM agent_knowledge
       WHERE ${KUZMICH_KNOWLEDGE_SCOPE_SQL}
         AND (title ILIKE $1 OR compiled_truth ILIKE $1)
       ORDER BY
         CASE WHEN type = 'indigenous' THEN 1 ELSE 2 END,
         updated_at DESC
       LIMIT 5`,
      [containsPattern(placeName)],
    ),
    // Маршруты по названию — факты маршрута (14.10, см. routeFactsLines).
    routesByName(placeName),
  ]);

  // Места нет — спросить сводки вулканов (#2134): вулкан без записи в
  // справочнике (Чикурачки на Парамушире) есть в KVERT, и ответ «ничего нет»
  // при оранжевом коде читался как «там спокойно». Отказ чтения сводок — в
  // лог и дальше без них: «не смогли спросить» не равно «вулкана нет».
  let volcanoLines: string[] | null = null;
  if (placesRes.rows.length === 0) {
    try {
      volcanoLines = volcanoLinesForName(await loadVolcanoInput(), placeName);
    } catch (err) {
      console.error('[guardian] сводки вулканов не прочитаны:', err instanceof Error ? err.message : err);
    }
  }

  if (placesRes.rows.length === 0 && alertsRes.rows.length === 0 && knowledgeRes.rows.length === 0 && !volcanoLines
      && !namedRoutes?.length) {
    return '';
  }

  const parts: string[] = [];

  // Места по этому названию нет, а заметки или алерты с ним есть (issue
  // #2063): без этой строки ответ из одной этнографии читался как полный —
  // турист не видел, что статуса, KVERT и опасностей в нём нет вовсе. «Не
  // знаю» говорится словами (§4.0), а не подменяется тем, что нашлось.
  if (placesRes.rows.length === 0 && volcanoLines) {
    parts.push(
      `Места «${placeName}» в справочнике Ведара нет, поэтому статус безопасности места не рассчитан — ` +
      `это НЕ значит, что там безопасно. Вулкан есть в сводках вулканов:`,
      ...volcanoLines,
      `Экстренный вызов на Камчатке — ${EMERGENCY_PRIMARY.phone}.`,
    );
  } else if (placesRes.rows.length === 0) {
    parts.push(
      `Места «${placeName}» в справочнике не нашлось — статуса, кодов KVERT и КФ ЕГС ` +
      `и опасностей по этому названию нет. Ниже только то, где название упомянуто; ` +
      `уточни точное название места, прежде чем говорить о его безопасности.`,
    );
  }

  // Дедуп алертов между записями: зонные/общерегиональные алерты приходят в
  // active_alerts КАЖДОГО совпавшего места (safety-ingest, зона без координат),
  // и один и тот же список печатался трижды подряд, раздувая контекст втрое
  // (проба 113: 6.5 КБ, из них ~3 КБ — повторы). Каждый алерт показывается
  // один раз — при первом упоминании; ни один не теряется.
  const shownAlerts = new Set<string>();
  const freshAlerts = (list: string[]): string[] => {
    const fresh = list.filter((a) => !shownAlerts.has(a));
    fresh.forEach((a) => shownAlerts.add(a));
    return fresh;
  };

  // Маршруты через место, о котором ответ (первое видимое с сильным
  // совпадением): их факты идут в блок маршрутов ниже. undefined — не
  // читали; null — база отказала.
  let throughRoutes: PlaceRouteRow[] | null | undefined;

  for (const p of placesRes.rows) {
    const rawStatus = p.recommender_status ? STATUS_LABEL[p.recommender_status] ?? p.recommender_status : null;
    // Цвет без времени пересчёта — обязательное поле, заполненное враньём
    // (§4.0): зелёный печатался одинаково при живом пересчёте и при
    // вставшем. Устарел — цвет не показываем и говорим почему.
    const updatedMs = p.status_updated_at ? Date.parse(p.status_updated_at) : NaN;
    const statusStale = rawStatus !== null && Number.isFinite(updatedMs) && Date.now() - updatedMs > STATUS_FRESH_MS;
    // Северные Курилы: зелёный значит «камчатских сводок нет», а не
    // «предупреждений нет» — цвет не печатаем, как и у карточки (16.10).
    const outsideGreen = p.recommender_status === 'green' && isOutsideKraiSources(p.zone);
    const status = statusStale || outsideGreen ? null : rawStatus;
    // Раздел каталога — в заголовке, рядом с именем. До 17.09 location_type
    // выбирался этим же запросом и не печатался: тип был виден только на
    // бейдже карточки и маркере карты, а в MCP — единственном канале, которым
    // прод читается из сессии, — его не было. Так два городских холма
    // месяцами носили «ВУЛКАН» (972-974), и проверить починку было нечем.
    // Типа нет → ничего не печатаем (не «Место»): «не записано» не равно
    // «известно, что это место» (§4.0).
    const kind = placeTypeLabel(p.location_type);
    const nameWithKind = kind ? `${p.name} (${kind.toLowerCase()})` : p.name;
    const header = status
      ? `${nameWithKind} [${status}${p.is_open === false ? ' — ЗАКРЫТО' : ''}]`
      : nameWithKind;
    parts.push(header);
    if (statusStale) {
      parts.push(`Статус места не пересчитывался с ${kamchatkaStamp(p.status_updated_at!)} (по Камчатке) — цвет не показываю: он может быть уже не про сегодня.`);
    } else if (outsideGreen) {
      parts.push(KURIL_NORTH_NOTE);
    } else if (p.recommender_status === 'green') {
      const when = Number.isFinite(updatedMs) ? `, пересчёт ${kamchatkaStamp(p.status_updated_at!)} по Камчатке` : '';
      parts.push(`ЗЕЛЁНЫЙ значит: активных предупреждений по месту не найдено${when}. Это не гарантия безопасности.`);
    }
    if (p.linked_volcanoes) {
      // Цвет в скобках заголовка — статус МЕСТА для выхода, а не авиационный
      // код KVERT. 08.10 канальный бот дважды подряд принял «Шивелуч
      // [КРАСНЫЙ]» рядом с «KVERT: ОРАНЖЕВЫЙ» за расхождение данных: два цвета
      // двух разных шкал стояли рядом без слова о том, какой из них что значит.
      parts.push(
        `Место у вулкана ${p.linked_volcanoes}: статус учитывает его шкалы KVERT и КФ ЕГС. ` +
        `Цвет в скобках — статус места для выхода, а не код KVERT: ` +
        `оранжевый или красный код KVERT делает статус места красным.`,
      );
    }
    // Лежбище или место скопления морских млекопитающих: правила посещения —
    // из постановления, а не из головы модели (lib/safety/marine-mammals).
    // Только по названию места, и только когда совпадение с запросом сильное:
    // при слабом совпадении это может быть чужое место.
    if (gradePlaceMatch(placeName, p.name, p.aliases) === 'high' && isMarineMammalPlace(p.name)) {
      parts.push(marineMammalNote());
    }

    if (gradePlaceMatch(placeName, p.name, p.aliases) === 'low') {
      // Слабое совпадение по названию (в т.ч. из-за русской морфологии —
      // "Авачинский" vs "Авачинская сопка" рвёт префиксное сравнение) — не
      // факт что это то же место, которое спросил пользователь. Высоту,
      // расстояние до медпомощи и т.п. этого места не прикладываем — они
      // могут быть про другой объект. Но активный алерт молчать нельзя:
      // на safety-платформе тихо уронить реальное предупреждение опаснее,
      // чем один лишний уточняющий вопрос — отдаём его с явной рамкой
      // неуверенности вместо простого отказа.
      const hedge =
        `(!) "${p.name}" — неточное совпадение по названию с запросом "${placeName}", ` +
        `данные этого места ниже не приложены. Уточни у пользователя точное ` +
        `название, прежде чем говорить про статус или опасности.`;
      const hedgeAlerts = p.active_alerts?.length ? freshAlerts(p.active_alerts) : [];
      if (p.alert_message) {
        parts.push(`${hedge} Но по похожему названию есть активный алерт: ${p.alert_message} — уточни, относится ли он к месту, которое спросили.`);
      } else if (hedgeAlerts.length) {
        parts.push(`${hedge} Но по похожему названию есть активные алерты: ${hedgeAlerts.join(', ')} — уточни, относятся ли они к месту, которое спросили.`);
      } else {
        parts.push(hedge);
      }
      // Оранжевый/красный ACC — как и алерт, нельзя молча уронить при слабом
      // совпадении: отдаём с рамкой неуверенности.
      const lowAcc = accOf(p);
      if (lowAcc === 'orange' || lowAcc === 'red') {
        parts.push(`Но по похожему названию вулкан под кодом KVERT ${ACC_META[lowAcc].short.toUpperCase()} (${ACC_META[lowAcc].label.toLowerCase()}) — уточни, тот ли это вулкан.`);
      }
      // То же для шкалы КФ ЕГС: критичный уровень свежей сводки не роняется.
      if (levelForColor(p.kfegs_color) === 'critical' && kfegsIsFresh(p.kfegs_date)) {
        parts.push(`Но по похожему названию у вулкана уровень КФ ЕГС ${p.kfegs_color === 'red' ? 'красный' : 'оранжевый'} — уточни, тот ли это вулкан.`);
      }
      continue;
    }

    // Алерты первыми — безопасность важнее описания
    if (p.alert_message) {
      parts.push(`Алерт: ${p.alert_message}`);
    } else if (p.active_alerts?.length) {
      const fresh = freshAlerts(p.active_alerts);
      const repeated = p.active_alerts.length - fresh.length;
      if (fresh.length) parts.push(`Активные алерты: ${fresh.join(', ')}.`);
      // Повторы убраны ради объёма, но причина цвета обязана остаться видна:
      // 03.10 «Скала Черный замок [КРАСНЫЙ]» шла без единого алерта — те же
      // алерты уже были напечатаны у Горы Замок выше, и красный читался как
      // необъяснённый (владелец: «статус опасности не снят»).
      if (repeated > 0) {
        parts.push(fresh.length
          ? `И ещё ${repeated} — те же, что у места выше.`
          : `Активные алерты: те же, что у места выше (${repeated}).`);
      }
    }

    // Авиационный цветовой код вулкана (KVERT, migration 728) — сразу после
    // алертов: прямой safety-сигнал. Наблюдённого кода нет → молчим (не «зелёный»).
    const acc = accOf(p);
    if (acc) parts.push(accLine(acc, p));
    const kfegs = kfegsLine(p);
    if (kfegs) parts.push(kfegs);
    // Спросили САМ вулкан: пояснение шкал печаталось только у мест,
    // привязанных к вулкану (linked_volcanoes), а «Шивелуч [КРАСНЫЙ]» над
    // «KVERT: ОРАНЖЕВЫЙ» у самого Шивелуча шёл без слова — и проверка MCP
    // 08.10 записала это расхождением источников (#2315). Правило то же, что
    // в safety-ingest: оранжевый или красный код поднимает место до красного.
    if ((acc || kfegs) && status && !p.linked_volcanoes) {
      parts.push(
        'Цвет в скобках у названия — статус места для выхода (учитывает шкалы KVERT и КФ ЕГС), а не код KVERT: ' +
        'оранжевый или красный код KVERT делает статус места красным.',
      );
    }

    // Опасности, лимит и сложность у большинства мест выведены шаблоном 070 из
    // location_type, а не измерены. Проводник произносит их предложениями
    // («Есть лавинная опасность»), то есть звучит увереннее любого бейджа —
    // поэтому доказанный шаблон он не произносит вовсе
    // (lib/safety/profile-source.ts, миграция 1100).
    const honest = honestSafetyFields(
      {
        hazardTypes: p.hazard_types ?? [],
        capacityPerDay: p.capacity_per_day,
        optimalGroupSize: null,
        difficultyLevel: p.difficulty_level,
        terrainType: null,
      },
      asProfileSource(p.profile_source),
    );

    if (p.tourists_today !== null && honest.capacityPerDay) {
      parts.push(`Сегодня посетило: ${p.tourists_today} чел. (норма ${honest.capacityPerDay}/день).`);
    }

    if (p.altitude_m) parts.push(`Высота ${p.altitude_m} м.`);

    if (p.nearest_medical_km) {
      parts.push(`До медпомощи: ${p.nearest_medical_km} км.`);
    }

    if (p.sat_communicator_required) {
      parts.push('Требуется спутниковый коммуникатор.');
    }

    if (honest.hazardTypes.length) {
      const hazards = honest.hazardTypes.map((h) => hazardLabelLower(h)).join(', ');
      parts.push(`Опасности: ${hazards}.`);
    } else {
      // «Профиль безопасности не оцифрован» модель читала как «место не
      // оцифровано» и отвечала туристу, что горы Замок на платформе нет
      // (скрин владельца 03.10), — при живой карточке с координатами.
      // Отсутствие разметки опасностей называется так, чтобы его нельзя было
      // принять ни за отсутствие места, ни за отсутствие опасностей.
      // С 14.10 — всегда, когда опасностей нет: известная высота не отвечает
      // на вопрос об опасностях, а молчание о них читалось как «их нет».
      parts.push('Опасности этого места в базе не размечены — это не значит, что их нет. Само место в справочнике есть.');
    }
    const unrecorded = unrecordedSafetyLine(p);
    if (unrecorded) parts.push(unrecorded);

    // Координаты и ссылка — у того места, о котором ответ, а не у первого
    // видимого по имени: при скрытом месте общий поиск увёл бы ссылку на
    // соседа. Скрытое место не называет ни того, ни другого
    // (place-info-tool: скрывают в том числе за ложную координату).
    if (p.is_visible !== false) {
      const lat = p.lat != null ? Number(p.lat) : NaN;
      const lng = p.lng != null ? Number(p.lng) : NaN;
      if (Number.isFinite(lat) && Number.isFinite(lng)) parts.push(`Координаты: ${lat.toFixed(5)}, ${lng.toFixed(5)}`);
      if (p.id && (opts.pageLinks || throughRoutes === undefined)) {
        const routes = await placeRoutesFor(p.id);
        if (opts.pageLinks) {
          parts.push(`Страница места на сайте: ${placePageUrl(p.id)}`);
          parts.push(...routesLinesFrom(routes));
        }
        if (throughRoutes === undefined) throughRoutes = routes;
      }
    }

    // Тот же фильтр голоса, что у get_place_info: путевая заметка не
    // выдаётся за наблюдение о месте (аудит MCP 29.09).
    const descLine = describeForAgent(p.description, 300);
    if (descLine) parts.push(descLine);
  }

  for (const a of alertsRes.rows) {
    // active_alerts мест хранит те же ea.title (safety-ingest) — алерт, уже
    // показанный в строке места, здесь не повторяем.
    if (shownAlerts.has(a.title)) continue;
    shownAlerts.add(a.title);
    // Источник — по ленте, из которой пришла тревога, а не одной подписью
    // «КБГС/МЧС» на все шесть лент (проверка MCP 29.09).
    const origin = alertOrigin(a.external_id, a.source_url)?.label ?? UNKNOWN_ORIGIN_TEXT;
    // Место названо только в теле сводки — печатается фрагмент о нём, а не
    // чужой заголовок и начало сводки (#2699, lib/kuzmich/alert-mention).
    const line = alertLineForPlace(a, placeName, origin);
    if (line) parts.push(line);
  }

  // Факты маршрутов (14.10): сначала найденные по названию — их назвал сам
  // человек, — затем маршруты через место. Отказ базы — словами (§4.0); в
  // чате отказ чтения маршрутов места уже назван строкой у места.
  const factRoutes: RouteFactsSource[] = [
    ...(namedRoutes ?? []),
    ...(throughRoutes ?? []).filter((r) => r.link_kind !== 'nearby'),
  ];
  parts.push(...routeFactsLines(factRoutes));
  if (namedRoutes === null || (throughRoutes === null && !opts.pageLinks)) {
    parts.push('Маршруты к этому месту проверить не удалось — не говори, что их нет.');
  }

  for (const k of knowledgeRes.rows) {
    if (k.type === 'indigenous') {
      parts.push(`[Традиционные знания] ${k.title}: ${k.compiled_truth.slice(0, 200)}`);
    } else {
      parts.push(`${k.title}: ${k.compiled_truth.slice(0, 200)}`);
    }
  }

  return parts.join('\n');
}
