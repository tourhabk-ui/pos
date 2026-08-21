/**
 * lib/routes/desc-facts.ts — сверка описания маршрута с его же фактами.
 *
 * Кампания владельца 21.08: описания в массе переписаны AI, и там уже
 * дважды находилась выдумка («долина Паратунки» у Озерков на Пиначевке,
 * generic-тексты бывших «Зимних сказок»). Выдумку как таковую
 * детерминированно не поймать; ловится ПРОТИВОРЕЧИЕ тому, что платформа
 * знает сама:
 *
 *   - числа текста против чисел записи: «12 километров» при дистанции
 *     1.6 км — текст врёт либо запись, и оба варианта требуют человека;
 *   - упомянутое место из реестра, стоящее за десятки км от маршрута:
 *     сосед в двух км — законный контекст, объект в 40 км — чужая
 *     география, приехавшая с переписыванием;
 *   - обещание трека при отсутствии линии и совет сойти с тропы —
 *     переиспользуются гварды постов (post-validation), правило одно.
 *
 * Судья только СРАВНИВАЕТ и предлагает: чинить текст или запись — решение
 * человека (как перепись имён). Пороги расхождения объявлены константами:
 * вдвое И заметно в абсолюте — меньшее тонет в честных округлениях.
 */

export interface ClaimedNumbers {
  distanceKm: number | null;
  durationH: number | null;
  gainM: number | null;
}

export interface RouteFacts {
  distanceKm: number | null;
  durationH: number | null;
  gainM: number | null;
}

export interface DescFinding {
  kind:
    | 'distance_mismatch'
    | 'duration_mismatch'
    | 'gain_mismatch'
    | 'far_place'
    | 'track_claim_no_line'
    | 'leaves_trail';
  detail: string;
}

/**
 * Описание обещает трек/GPS. Узкий регэксп, а не promisesRouteOrTrack из
 * post-validation: тот считает уликой и слово «маршрут», что для ПОСТА со
 * ссылкой верно, а в описании МАРШРУТА — тавтология (offenders_total = всем).
 * «Треккинг»/«трекинг» — вид активности, исключены как и там.
 */
export function claimsTrack(text: string): boolean {
  return /\bgps\b|джи-?пи-?эс|трек(?!к|инг)[а-яё]*/i.test(text);
}

/** Вдвое и заметно в абсолюте — иначе спорим с округлением, а не с враньём. */
export const MISMATCH_RATIO = 2;
export const MIN_ABS_KM = 3;
export const MIN_ABS_H = 2;
export const MIN_ABS_GAIN_M = 300;
/** Дальше этого упомянутое место — не сосед маршрута. */
export const FAR_PLACE_KM = 30;

const NUM = `(\\d+(?:[.,]\\d+)?)`;

function parseNum(s: string): number {
  return parseFloat(s.replace(',', '.'));
}

/** Предложение вокруг позиции — окно, в котором ищется контекст утверждения. */
function sentenceAround(t: string, idx: number): string {
  const starts = ['.', '!', '?', '\n'].map(c => t.lastIndexOf(c, idx));
  const start = Math.max(-1, ...starts) + 1;
  const ends = ['.', '!', '?', '\n'].map(c => t.indexOf(c, idx)).filter(i => i !== -1);
  const end = ends.length > 0 ? Math.min(...ends) : t.length;
  return t.slice(start, end);
}

/**
 * Предложение говорит о ПУТИ, а не о положении. Проба 125: «начинается
 * в 20 км от Петропавловска» — расстояние ДО маршрута, не длина маршрута,
 * и таких было большинство среди 43 «расхождений».
 */
const DIST_CONTEXT_RE =
  /протяж|длин|дистанц|маршрут|троп|путь|пути|переход|одну сторону|туда и обратно|сплав|прогулк|восхожден|подъем|поход|пройти|пройдете/;
const DUR_CONTEXT_RE =
  /займ|длит|потребу|в пути|переход|восхожден|подъем|маршрут|троп|путь|дорога|сплав|прогулк|поход|ходьб|идти/;
/**
 * «в 20 км от», «40 км к югу» — география, не длина. Матч кончается на
 * основе («20 км», «20 километр»), поэтому лукахед терпит хвост словоформы.
 */
const LOCATION_AFTER_RE =
  /^[а-яa-z]*\s*(?:от[\s,.]|к\s+(?:югу|северу|западу|востоку)|севернее|южнее|западнее|восточнее)/;
/** «2,5 часа езды», «час лёта» — доставка, не прохождение. */
const TRANSPORT_AFTER_RE =
  /^[а-яa-z]*\s*(?:езды|лета|полета|на\s+(?:машине|автобусе|вертолете|катере|лодке))/;

/**
 * Первое числовое утверждение каждого рода — с контекстом. Диапазон
 * «8-10 часов» читается серединой: спорить с ним можно, только выйдя
 * за него вдвое. Матч без слова о пути в предложении пропускается.
 */
export function parseClaimedNumbers(text: string): ClaimedNumbers {
  const t = text.toLowerCase().replace(/ё/g, 'е');

  const range = (re: RegExp, contextRe: RegExp, notAfterRe: RegExp): number | null => {
    const g = new RegExp(re.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = g.exec(t)) !== null) {
      const after = t.slice(m.index + m[0].length);
      if (notAfterRe.test(after)) continue;
      if (!contextRe.test(sentenceAround(t, m.index))) continue;
      const a = parseNum(m[1]);
      const b = m[2] ? parseNum(m[2]) : a;
      return (a + b) / 2;
    }
    return null;
  };

  return {
    // Не «км\b»: \b в JS не знает кириллицы (см. post-validation) — граница
    // после «м» не находится никогда. Лукахед: дальше не буква.
    distanceKm: range(
      new RegExp(`${NUM}(?:\\s*[-–—]\\s*${NUM})?\\s*(?:км(?![а-яa-z])|километр)`),
      DIST_CONTEXT_RE, LOCATION_AFTER_RE,
    ),
    durationH: range(
      new RegExp(`${NUM}(?:\\s*[-–—]\\s*${NUM})?\\s*(?:час|ч\\.)`),
      DUR_CONTEXT_RE, TRANSPORT_AFTER_RE,
    ),
    // У набора высоты контекст уже в самом паттерне («набор») — окно не нужно.
    gainM: (() => {
      const m = t.match(new RegExp(
        `набор(?:а|ом)?(?:\\s+высоты)?\\s*(?:[-–—:]\\s*)?(?:около\\s*|~\\s*)?${NUM}(?:\\s*[-–—]\\s*${NUM})?\\s*м`,
      ));
      if (!m) return null;
      const a = parseNum(m[1]);
      const b = m[2] ? parseNum(m[2]) : a;
      return (a + b) / 2;
    })(),
  };
}

function mismatch(claim: number, fact: number, minAbs: number): boolean {
  const lo = Math.min(claim, fact);
  const hi = Math.max(claim, fact);
  if (lo <= 0) return hi >= minAbs;
  return hi / lo >= MISMATCH_RATIO && hi - lo >= minAbs;
}

export function compareFacts(claims: ClaimedNumbers, facts: RouteFacts): DescFinding[] {
  const out: DescFinding[] = [];
  if (claims.distanceKm !== null && facts.distanceKm !== null &&
      mismatch(claims.distanceKm, facts.distanceKm, MIN_ABS_KM)) {
    out.push({ kind: 'distance_mismatch', detail: `в тексте ${claims.distanceKm} км, в записи ${facts.distanceKm} км` });
  }
  if (claims.durationH !== null && facts.durationH !== null &&
      mismatch(claims.durationH, facts.durationH, MIN_ABS_H)) {
    out.push({ kind: 'duration_mismatch', detail: `в тексте ${claims.durationH} ч, в записи ${facts.durationH} ч` });
  }
  if (claims.gainM !== null && facts.gainM !== null &&
      mismatch(claims.gainM, facts.gainM, MIN_ABS_GAIN_M)) {
    out.push({ kind: 'gain_mismatch', detail: `в тексте набор ${claims.gainM} м, в записи ${facts.gainM} м` });
  }
  return out;
}

export interface PlaceRef { name: string; lat: number; lng: number }

function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Имя места в тексте живёт в падежах («в долине Паратунки»), строгий includes
 * видит только именительный. Слова ≥5 букв матчатся основой (без 1-2 конечных
 * букв + хвост до 4 букв), короткие — точно. Не стемминг-эвристика: правило
 * фиксированное, а ложные срабатывания глушатся фильтрами выше (длина имени,
 * стоп-список, совпадение с именем маршрута).
 */
function nameLoosePattern(normName: string): RegExp {
  const tokens = normName.split(/[\s-]+/).filter(Boolean).map(w => {
    if (w.length >= 6) return escapeRe(w.slice(0, -2)) + '[а-яa-z]{0,4}';
    if (w.length === 5) return escapeRe(w.slice(0, -1)) + '[а-яa-z]{0,3}';
    return escapeRe(w);
  });
  return new RegExp(tokens.join('[\\s-]+'));
}

/**
 * Слишком общие имена, которые законно звучат в любом описании.
 * Явный стоп-список, не эвристика.
 */
const GENERIC_PLACE_RE = /^(камчатка|тихий океан|авачинская бухта|петропавловск)/i;

/** Перепись зовёт судью сотни раз на одном реестре — паттерн имени компилируется однажды. */
const patternCache = new Map<string, RegExp>();

export function mentionedFarPlaces(
  text: string,
  routeLat: number | null,
  routeLng: number | null,
  routeTitle: string,
  places: PlaceRef[],
): DescFinding[] {
  if (routeLat === null || routeLng === null) return [];
  const t = norm(text);
  const title = norm(routeTitle);
  const out: DescFinding[] = [];
  for (const p of places) {
    // Короткое имя матчится в чужих словах, одно слово — в чужих именах:
    // судим только именами, которые не спутать.
    if (p.name.length < 8 && !p.name.includes(' ')) continue;
    if (GENERIC_PLACE_RE.test(p.name)) continue;
    const pn = norm(p.name);
    let re = patternCache.get(pn);
    if (!re) { re = nameLoosePattern(pn); patternCache.set(pn, re); }
    // Имя места, входящее в имя маршрута, — сам предмет описания.
    if (title.includes(pn) || pn.includes(title) || re.test(title)) continue;
    const m = re.exec(t);
    if (!m) continue;
    // Имя собственное узнаётся заглавной буквой в исходном тексте: проба 125
    // показала, что «Каменистый» и «Спокойный» из реестра матчатся в
    // «каменистое дно» и «спокойной воде» — это слова, не места. Нормализация
    // сохраняет длину, поэтому срез оригинала по индексу матча честен.
    const originalSpan = text.slice(m.index, m.index + m[0].length);
    if (!/[А-ЯЁA-Z]/.test(originalSpan)) continue;
    const km = haversineKm(routeLat, routeLng, p.lat, p.lng);
    if (km >= FAR_PLACE_KM) {
      out.push({ kind: 'far_place', detail: `упомянуто «${p.name}» в ${Math.round(km)} км от маршрута` });
    }
  }
  return out;
}
