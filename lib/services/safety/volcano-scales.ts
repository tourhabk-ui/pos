/**
 * lib/services/safety/volcano-scales.ts — вулкан на радаре по ДВУМ шкалам.
 *
 * Решение владельца 24.09: «да, показывай обе шкалы на радаре».
 *
 *   KVERT  (volcano_status)          — авиационный код ICAO, про пепел для
 *                                      самолётов;
 *   КФ ЕГС (volcano_bulletin_kfegs)  — своя шкала: сейсмичность, газ,
 *                                      термоаномалии, пепел. Легенда — в
 *                                      самой сводке.
 *
 * Слова цветов совпадают, определения — нет. Поэтому ни одна шкала не
 * побеждает и не перезаписывает другую: вулкан рисуется, если он повышен
 * ХОТЯ БЫ по одной, а в подписи стоят обе, каждая со своим смыслом. Турист
 * видит не «жёлтый», а «жёлтый у КФ ЕГС — сейсмичность выше фона, 255
 * событий; у KVERT (авиация) зелёный».
 *
 * Уровень метки — одинаковый для обеих шкал: жёлтый → «опасно», оранжевый и
 * красный → «критично». Так было у KVERT до этой правки; держать другую
 * лестницу для КФ ЕГС значило бы показывать два жёлтых с разным весом, и
 * человек не понял бы почему. При сомнении — в сторону осторожности: жёлтый
 * КФ ЕГС — это и повышенная эмиссия газов, а к кратеру Мутновского ходят
 * пешком.
 *
 * Неразобранный код КФ ЕГС («Белый» — в легенде источника его нет) метку НЕ
 * ставит: «мониторинг невозможен» — не опасность. Но если вулкан повышен по
 * KVERT, в подписи честно сказано, что вторая шкала молчит и почему.
 *
 * Только сборка: ни сети, ни БД.
 */

export type ScaleColor = 'green' | 'yellow' | 'orange' | 'red';
export type RadarLevel = 'critical' | 'danger' | 'warning';

export interface KfegsReading {
  /** null — код не разобран; дословно — в raw. */
  color: ScaleColor | null;
  raw: string;
  seismicity: string | null;
  /** Сутки сводки, YYYY-MM-DD. */
  date: string;
}

export interface VolcanoPlacePoint {
  name: string;
  lat: number;
  lng: number;
}

export interface VolcanoMark {
  lat: number;
  lng: number;
  level: RadarLevel;
  label: string;
  note: string;
}

const ELEVATED: ReadonlySet<string> = new Set(['yellow', 'orange', 'red']);

const RU: Record<ScaleColor, string> = {
  green: 'зелёный', yellow: 'жёлтый', orange: 'оранжевый', red: 'красный',
};

/** Уровень метки по коду. Одинаковый для обеих шкал — см. шапку. */
export function levelForColor(color: string | null | undefined): RadarLevel | null {
  if (color === 'yellow') return 'danger';
  if (color === 'orange' || color === 'red') return 'critical';
  return null;
}

const RANK: Record<RadarLevel, number> = { warning: 0, danger: 1, critical: 2 };

function ruDate(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${d}.${m}`;
}

/** Первая содержательная фраза графы сейсмичности, без «R=…; Ks пред.=…». */
function seismicityGist(s: string | null): string | null {
  if (!s) return null;
  const cleaned = s.replace(/R\s*[=~]\s*[\d.]+;?/g, '').replace(/Ks\s*пред\.\s*=\s*[\d.]+;?/g, '').trim();
  return cleaned ? cleaned.slice(0, 160) : null;
}

/**
 * Фраза о вулкане по шкале КФ ЕГС — одна на радар и на контекст Кузьмича/MCP
 * (`lib/kuzmich/guardian-context.ts`). Две копии одной фразы разошлись бы, и
 * турист прочёл бы на радаре одно, а от Кузьмича — другое.
 *
 * null — свежей сводки нет: так и сказано, а не пропущено.
 */
export function kfegsPhrase(k: KfegsReading | null): string {
  if (!k) return 'КФ ЕГС: свежей сводки нет';
  const date = ruDate(k.date);
  if (k.color) {
    const gist = seismicityGist(k.seismicity);
    return `КФ ЕГС (сейсмичность, за ${date}): ${RU[k.color]}${gist ? ` — ${gist}` : ''}`;
  }
  return `КФ ЕГС (за ${date}): код «${k.raw}» — значение неизвестно, наблюдение не оценено`;
}

/**
 * Собрать метки вулканов для радара.
 *
 * @param kvert  код KVERT по ark_id места (все известные, не только повышенные)
 * @param kfegs  чтение КФ ЕГС по ark_id места — ТОЛЬКО из свежей сводки;
 *               устаревшую вызывающий сюда не передаёт
 * @param places координаты и имя по ark_id
 */
export function volcanoMarks(
  kvert: ReadonlyMap<string, string>,
  kfegs: ReadonlyMap<string, KfegsReading>,
  places: ReadonlyMap<string, VolcanoPlacePoint>,
): VolcanoMark[] {
  const ids = new Set<string>();
  for (const [id, acc] of kvert) if (ELEVATED.has(acc)) ids.add(id);
  for (const [id, k] of kfegs) if (k.color && ELEVATED.has(k.color)) ids.add(id);

  const marks: VolcanoMark[] = [];
  for (const id of ids) {
    const place = places.get(id);
    if (!place) continue;

    const acc = kvert.get(id) ?? null;
    const k = kfegs.get(id) ?? null;
    const levels = [levelForColor(acc), levelForColor(k?.color)].filter((l): l is RadarLevel => l !== null);
    if (levels.length === 0) continue;
    const level = levels.sort((a, b) => RANK[b] - RANK[a])[0];

    const parts: string[] = [kfegsPhrase(k)];
    parts.push(acc
      ? `KVERT (авиация): ${RU[acc as ScaleColor] ?? acc}`
      : 'KVERT (авиация): кода нет');

    marks.push({
      lat: place.lat,
      lng: place.lng,
      level,
      label: place.name,
      note: `${parts.join(' · ')}. Держитесь вне закрытой зоны.`,
    });
  }
  return marks;
}

/**
 * Свежа ли сводка. Она выходит «за прошедшие сутки», то есть в день D
 * лежит сводка за D−1, и от ПОЛУНОЧИ её даты до чтения проходит уже больше
 * суток. Отсюда «+1» в сравнении: допускается одна пропущенная сводка (могли
 * опубликовать поздно), вторая подряд — сводка устарела, и показывать её цвет
 * как текущий нельзя. Пример: сводка за 22.09 свежа до начала 25.09 UTC
 * (трое суток от полуночи 22.09) — это держит сторож volcano-scales.test.ts.
 */
export const KFEGS_MAX_AGE_DAYS = 2;

export function kfegsIsFresh(observedDate: string | null, nowMs: number = Date.now()): boolean {
  if (!observedDate) return false;
  const t = Date.parse(`${observedDate}T00:00:00Z`);
  if (Number.isNaN(t)) return false;
  return (nowMs - t) / 86_400_000 <= KFEGS_MAX_AGE_DAYS + 1;
}
