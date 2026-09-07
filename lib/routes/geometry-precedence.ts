/**
 * lib/routes/geometry-precedence.ts — кто вправе переписать линию маршрута.
 *
 * ── Что случилось (замер 07.09) ────────────────────────────────────────────
 *
 * Линию в `kamchatka_routes.geometry` кладут семь независимых схем, и правило
 * «что кому можно переписать» было скопировано в каждую руками. Копии
 * разошлись — вот замер по коду:
 *
 *   osm-import-runner        geometry IS NULL ИЛИ source = 'waypoints_synthetic'
 *   idilesom-importer        geometry IS NULL ИЛИ source = 'idilesom'
 *   kml-inbox                только geometry IS NULL
 *   route-lay (A* по графу)  только geometry IS NULL
 *   visitkamchatka-gpx       УСЛОВИЯ НЕТ ВОВСЕ — затирает что угодно
 *   track-import-queue       УСЛОВИЯ НЕТ ВОВСЕ — затирает что угодно
 *
 * Два последних молча перекрывают снятый трек скрейпом или наоборот: чей
 * прогон случился позже, того и линия. На карте это не мелочь — §12: линия
 * есть обещание, по ней человек идёт.
 *
 * А одна копия к тому же УЖЕ МЕРТВА. Миграция 871 переименовала слог скрейпа
 * в базе ('idilesom' → 'external'), но `idilesom-importer` сравнивает всё ещё
 * со старым слогом. Его ветка «обновить собственную линию» не совпадает ни с
 * одной из 252 живых линий скрейпа. Запрос живой, половина его — нет; тот же
 * класс, что стоил нам маяка воронки.
 *
 * ── Правило ────────────────────────────────────────────────────────────────
 *
 * Одно, в одном месте: линию перекрывает только источник СИЛЬНЕЕ. Сила — не
 * вкус, а мера того, чем линия подтверждена:
 *
 *   снятый прибором путь   — по нему прошли, запись есть;
 *   инфраструктура OSM     — размечена людьми на местности и проверяема;
 *   принесённый файл       — человек положил осознанно, за него отвечает;
 *   официальный паспорт    — ведомственный источник, но не запись прохода;
 *   скрейп чужого сайта    — записан, но никем не подтверждён (§12);
 *   построение по графу    — форма правдоподобна, путь не подтверждён;
 *   прямые между точками   — форма заведомо ложная (миграция 168).
 *
 * Равный источник переписывает сам себя — это обновление своих же данных.
 *
 * НЕИЗВЕСТНЫЙ слог не считается слабым. «Не знаю, чем это подтверждено» —
 * третье состояние (§4.0), и молча затирать по нему нельзя: незнание о силе
 * линии не даёт права её уничтожить.
 */

/** Слоги, встречающиеся в `geometry->>'source'`. */
export type GeometrySource =
  | 'field_track' | 'gpx' | 'osm_traces'
  | 'osm'
  | 'kml_inbox'
  | 'visitkamchatka'
  | 'external'
  | 'road_graph_astar'
  | 'waypoints_synthetic';

/**
 * Сила источника. Числа — только для сравнения между собой; их абсолютные
 * значения ничего не значат, и разрывы оставлены нарочно, чтобы новый
 * источник можно было вставить, не перенумеровывая соседей.
 */
export const GEOMETRY_RANK: Record<GeometrySource, number> = {
  // Прошли и записали прибором. Сильнее нет ничего.
  field_track: 100,
  gpx: 100,
  osm_traces: 100,
  // Размечено людьми на местности, проверяемо и исправимо.
  osm: 80,
  // Файл принёс человек — за него есть кому отвечать.
  kml_inbox: 70,
  // Ведомственный паспорт: источник официальный, но это не запись прохода.
  visitkamchatka: 60,
  // Скрейп чужого сайта: записан, но никем не подтверждён (§12,
  // UNVERIFIED_SOURCES — та же оценка, только там о виде линии).
  external: 50,
  // Построение по графу дорог: форма правдоподобна, путь не подтверждён.
  road_graph_astar: 30,
  // Прямые между точками. Форма заведомо ложная — слабее только пустота.
  waypoints_synthetic: 10,
};

/**
 * Прежний слог скрейпа. Миграция 871 переименовала его в базе, но забывать
 * нельзя: в полевых пакетах на телефонах лежат снимки, снятые ДО неё, и слог
 * в них уже не изменится (та же причина, что у UNVERIFIED_SOURCES в
 * lib/map/line-standard.ts).
 */
const LEGACY_SLUGS: Record<string, GeometrySource> = { idilesom: 'external' };

/** Привести слог к нынешнему. `null` — слог неизвестен, и это не «слабый». */
export function normalizeGeometrySource(raw: string | null | undefined): GeometrySource | null {
  if (!raw) return null;
  const s = raw.trim();
  if (s in LEGACY_SLUGS) return LEGACY_SLUGS[s];
  return s in GEOMETRY_RANK ? (s as GeometrySource) : null;
}

export interface OverwriteDecision {
  allowed: boolean;
  /** Почему — словами, для лога и для ответа переписи. */
  reason: string;
}

/**
 * Можно ли положить линию источника `incoming` поверх того, что лежит.
 *
 * `existing` — значение `geometry->>'source'` уже лежащей линии; `null` или
 * `undefined` означает, что линии нет вовсе.
 */
export function mayOverwrite(
  existing: string | null | undefined,
  incoming: GeometrySource,
): OverwriteDecision {
  if (existing === null || existing === undefined || existing === '') {
    return { allowed: true, reason: 'линии не было' };
  }
  const from = normalizeGeometrySource(existing);
  if (from === null) {
    // Незнание о силе линии не даёт права её уничтожить (§4.0).
    return { allowed: false, reason: `слог «${existing}» неизвестен — чем подтверждена линия, не знаем` };
  }
  if (from === incoming) {
    return { allowed: true, reason: 'тот же источник обновляет свои данные' };
  }
  const strongerIncoming = GEOMETRY_RANK[incoming] > GEOMETRY_RANK[from];
  return strongerIncoming
    ? { allowed: true, reason: `${incoming} сильнее ${from}` }
    : { allowed: false, reason: `${incoming} не сильнее ${from} — лежащая линия подтверждена не хуже` };
}

/**
 * Те слоги, поверх которых `incoming` класть ВПРАВЕ: слабее себя и свой
 * собственный (включая прежние написания).
 *
 * Возвращается для параметра запроса, а не для склейки в SQL: строка,
 * собранная конкатенацией, — то, чего в этом репозитории быть не должно.
 */
export function overwritableSources(incoming: GeometrySource): string[] {
  const list: string[] = [];
  for (const [slug, rank] of Object.entries(GEOMETRY_RANK) as Array<[GeometrySource, number]>) {
    if (slug === incoming || rank < GEOMETRY_RANK[incoming]) list.push(slug);
  }
  for (const [legacy, canonical] of Object.entries(LEGACY_SLUGS)) {
    if (list.includes(canonical)) list.push(legacy);
  }
  return list;
}

/**
 * Условие для WHERE: линии нет ИЛИ её слог входит в разрешённые.
 *
 * `paramIndex` — номер плейсхолдера массива в запросе вызывающего.
 * Неизвестный слог сюда не попадает по построению: перекрыть его нельзя.
 */
export function overwriteWhereSql(paramIndex: number, column = 'geometry'): string {
  return `(${column} IS NULL OR ${column}->>'source' = ANY($${paramIndex}::text[]))`;
}
