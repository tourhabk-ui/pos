/**
 * Ответ `get_place_info` — об ОДНОМ месте (25.09).
 *
 * Сверка MCP 25.09: «Курильское озеро» вернуло озеро, кальдеру и чужой кусок
 * про Долину гейзеров одним сплошным текстом. Причин две, обе в выборке:
 *
 *  - до трёх мест с похожим именем шли с ПОЛНЫМИ описаниями подряд — агент
 *    не мог понять, какое из них спрошенное;
 *  - заметки Кузьмича находились по `compiled_truth ILIKE '%запрос%'`, то есть
 *    по любому упоминанию в тексте: заметка о Долине гейзеров, где сказано
 *    «вертолёт летит мимо Курильского озера», становилась ответом об озере.
 *
 * Правило: первое (самое точное) место — целиком; остальные — только
 * названиями, с пометкой «спросите отдельно»; заметки — только те, чей
 * ЗАГОЛОВОК про это место (`gradeNameMatch`, то же правило, что у стража).
 *
 * Факты — впереди текста (26.09). Описание инструмента обещает «type,
 * coordinates, hazards», а ответом было одно `places.description` — у
 * Авачинского это рассказ от первого лица («Вчера поднялся…»), и внешняя
 * проверка MCP справедливо приняла его за художественный текст вместо
 * карточки. Теперь сначала строки фактов из `places` и
 * `location_safety_profile` (JOIN по `agent_route_id = places.ark_id`, §9),
 * потом «Описание:» — подписанным. Пустое поле — строки нет: ничего не
 * выдумывается (§4.0). Неизвестный ключ опасности пропускается — ответ читает
 * и Кузьмич вслух, а английское слово внутри русской фразы хуже пропуска
 * (то же решение, что у lib/kuzmich/place-advisory).
 */
import { pool } from '@/lib/db-pool';
import { placeNameOrAliasSearchSql } from '@/lib/places/name-match';
import { gradeNameMatch, placePageUrl, routesLinesForKuzmich } from '@/lib/kuzmich/guardian-context';
import { placeTypeLabel } from '@/lib/places/type-label';
import { HAZARDS } from '@/lib/safety/hazard-labels';
import { describeForAgent } from '@/lib/places/description-voice';
import { asProfileSource, honestSafetyFields } from '@/lib/safety/profile-source';
import { containsPattern } from '@/lib/db/like';
import { KUZMICH_KNOWLEDGE_SCOPE_SQL } from '@/lib/kuzmich/knowledge-scope';

export interface PlaceRow {
  /** id места — для ссылки на карточку (только в чате, см. pageLinks). */
  id?: string;
  name: string; description: string | null; category: string | null; district: string | null; is_visible?: boolean | null;
  location_type?: string | null;
  lat?: string | number | null; lng?: string | number | null;
  altitude_m?: number | null;
  hazard_types?: string[] | null;
  profile_source?: string | null;
  nearest_medical_km?: string | number | null;
  sat_communicator_required?: boolean | null;
  registration_required?: boolean | null;
}

/** Описание длиннее этого режется по концу предложения: карточка, не статья. */
export const PLACE_DESCRIPTION_MAX = 700;

function num(v: string | number | null | undefined): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}


/** Строки фактов о месте — только то, что записано. */
export function placeFactLines(p: PlaceRow): string[] {
  const lines: string[] = [];
  const type = placeTypeLabel(p.location_type ?? p.category);
  if (type) lines.push(`Тип: ${type.toLocaleLowerCase('ru-RU')}`);
  const lat = num(p.lat), lng = num(p.lng);
  // Скрытое место координату не называет. Скрывают в том числе ИМЕННО за
  // ложную координату, которую не на чем поправить (947 «Озеро Овальное» —
  // точка в 3 км от центра города вместо подножия Авачинского; 948 — лежбище
  // сивучей за 506 км): карточка уходит в MCP, и чужой ИИ повторил бы её
  // туристу как место на карте (проверка MCP 29.09). Остальное о месте —
  // как решено 19.09: страж может знать скрытое место.
  if (p.is_visible === false) {
    if (lat != null && lng != null) lines.push('Координаты: не называем — место снято с сайта, координата не подтверждена');
  } else if (lat != null && lng != null) {
    lines.push(`Координаты: ${lat.toFixed(5)}, ${lng.toFixed(5)}`);
  }
  if (p.altitude_m != null && p.altitude_m > 0) lines.push(`Высота: ${p.altitude_m} м`);
  // Опасности, выведенные шаблоном 070 из location_type, фактом не называются:
  // правило одно на платформу (lib/safety/profile-source.ts, миграция 1100).
  // Эта карточка уходит в MCP, то есть читает её чужой ИИ-клиент и повторяет
  // как факт — тем опаснее, чем дальше от базы.
  const hazards = honestSafetyFields(
    {
      hazardTypes: p.hazard_types ?? [],
      capacityPerDay: null, optimalGroupSize: null, difficultyLevel: null, terrainType: null,
    },
    asProfileSource(p.profile_source ?? null),
  ).hazardTypes
    .map((h) => HAZARDS[h]?.label?.toLocaleLowerCase('ru-RU'))
    .filter((h): h is string => Boolean(h));
  if (hazards.length > 0) lines.push(`Опасности: ${[...new Set(hazards)].join(', ')}`);
  const medical = num(p.nearest_medical_km);
  if (medical != null) lines.push(`До медпомощи: ${Math.round(medical)} км`);
  if (p.sat_communicator_required === true) lines.push('Спутниковая связь: нужна — сотовой может не быть');
  if (p.registration_required === true) lines.push('Регистрация группы в МЧС: требуется');
  return lines;
}
export interface NoteRow { title: string; compiled_truth: string }

export interface PlaceInfoOptions {
  /**
   * Дописать ссылку на карточку места (чат Кузьмича). Без неё модель на
   * просьбу «дай ссылку на место» отвечала, что страницы нет (скрин владельца
   * 03.10, «гора Замок»). На MCP не пишем: там своя ссылка
   * «Продолжить в Ведаре» (lib/mcp/handoff-targets).
   */
  pageLinks?: boolean;
  /** Строки маршрутов этого места (routesLinesForKuzmich) — внутрь карточки. */
  routeLines?: string[];
}

export function composePlaceInfo(query: string, places: PlaceRow[], notes: NoteRow[], opts: PlaceInfoOptions = {}): string | null {
  const [primary, ...rest] = places;
  // Скрытое место в «похожих» не называется (решение владельца 25.09): список
  // зовёт спросить о нём отдельно, а скрытые — это мусор вроде «Долина
  // гейзеров. Курильское озеро. Вулканы Горелый и Авача» (экскурсия, попавшая
  // в места) и сняты с сайта. Основной ответ правило 19.09 не меняет: страж
  // может знать скрытое место.
  const others = rest.filter((p) => p.is_visible !== false);
  const own = notes.filter((n) => gradeNameMatch(query, n.title) === 'high');
  if (!primary && own.length === 0) return null;

  const parts: string[] = [];
  // Места нет, заметка есть (issue #2063): «Ключевской» отдавал одну
  // легенду, и ответ выглядел полным. Отсутствие фактов называется словами.
  if (!primary) {
    parts.push(`Места «${query}» в справочнике не нашлось — тип, координаты и опасности по этому названию неизвестны. Ниже только заметка Кузьмича; уточните точное название места.`);
  }
  if (primary) {
    const cat = primary.category ? ` [${primary.category}]` : '';
    const district = primary.district ? ` (${primary.district})` : '';
    const card = [`${primary.name}${cat}${district}`, ...placeFactLines(primary)];
    // Голос описания (lib/places/description-voice): дневник — рассказ о
    // поездке, которой не было, и его «вчера», «фумаролы работают» агент
    // принял бы за наблюдение о сегодняшнем состоянии места. Не отдаём и
    // говорим почему; ощущения отдаём, но подписанными.
    // Ссылка — на ЭТУ запись, а не на первое видимое по имени; скрытое место
    // ссылки не получает (страницы у него нет).
    if (opts.pageLinks && primary.id && primary.is_visible !== false) {
      card.push(`Страница места на сайте: ${placePageUrl(primary.id)}`);
      card.push(...(opts.routeLines ?? []));
    }
    const descLine = describeForAgent(primary.description, PLACE_DESCRIPTION_MAX);
    if (descLine) card.push(descLine);
    parts.push(card.join('\n'));
  }
  for (const n of own) parts.push(`Заметка Кузьмича «${n.title}»: ${n.compiled_truth}`);
  if (others.length > 0) {
    parts.push(`Другие объекты с похожим названием — это ОТДЕЛЬНЫЕ места, спросите о них отдельно: ${others
      .map((o) => `${o.name}${o.category ? ` [${o.category}]` : ''}`).join('; ')}.`);
  }
  return parts.join('\n\n');
}

export async function placeInfoForKuzmich(placeName: string, opts: PlaceInfoOptions = {}): Promise<string | null> {
  // Слова, не буквальная фраза (issue #1987): «Горелый вулкан» не содержится
  // подстрокой в «Вулкан Горелый».
  // И псевдонимы (issue #2063): «Ключевской вулкан» — записанное имя
  // «Вулкан Ключевская сопка», а не подстрока его названия.
  const placeMatch = placeNameOrAliasSearchSql('p', placeName, 1);
  const [pr, kr] = await Promise.all([
    pool.query<PlaceRow>(
      // Слитые дубли отсекаются — то же правило, что у getGuardianContext и
      // resolvePlaceForLink, и та же сортировка «кратчайшее имя первым».
      // is_visible не фильтруется намеренно: у стража это записанное решение
      // («может знать скрытое место, но ссылку на невидимую страницу не даём»).
      `SELECT p.id::text AS id, p.name, p.description, p.category, p.district, p.is_visible,
              p.location_type, p.lat, p.lng,
              lsp.altitude_m, lsp.hazard_types, lsp.profile_source, lsp.nearest_medical_km,
              lsp.sat_communicator_required, lsp.registration_required
         FROM places p
         LEFT JOIN location_safety_profile lsp ON lsp.agent_route_id = p.ark_id
        WHERE p.merged_into_id IS NULL AND (${placeMatch.clause})
        ORDER BY char_length(p.name) ASC
        LIMIT 3`,
      placeMatch.params,
    ),
    pool.query<NoteRow>(
      // Только по заголовку: упоминание места в чужой заметке — не заметка о
      // нём. Роды — разрешённым списком (lib/kuzmich/knowledge-scope): у
      // search_result заголовок — сообщение туриста, и get_place_info с
      // name='меня зовут' отдавал его анонимному MCP-клиенту (проверка 29.09).
      `SELECT title, compiled_truth FROM agent_knowledge
        WHERE ${KUZMICH_KNOWLEDGE_SCOPE_SQL} AND title ILIKE $1
        LIMIT 3`,
      [containsPattern(placeName)],
    ),
  ]);
  // Маршруты — у той же записи, что в карточке, и только там, где дана ссылка:
  // скрытое место ссылки и маршрутов не получает.
  const primary = pr.rows[0];
  const routeLines = opts.pageLinks && primary?.id && primary.is_visible !== false
    ? await routesLinesForKuzmich(primary.id)
    : undefined;
  return composePlaceInfo(placeName, pr.rows, kr.rows, { ...opts, routeLines });
}
