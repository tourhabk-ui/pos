/**
 * Сводка погоды аэродрома (METAR) — разбор кода ВМО словами для табло /flights.
 *
 * Карт-бланш владельца 29.10 на бесплатные API: задержка на табло не
 * называет причину, а погода в аэропорту чаще всего она и есть — туман,
 * метель, боковой ветер. METAR аэродрома Елизово (UHPP) составляет АМСГ
 * аэропорта (Росгидромет); код один для всего мира, и разбор здесь не
 * зависит от того, откуда сводка пришла.
 *
 * Правила (§4.0):
 *  - разбираются только группы, которые мы знаем; незнакомая группа уходит в
 *    `unparsed` и словами не пересказывается — догадка о коде хуже кода, — но
 *    и не пропадает молча: строка «часть сводки не разобрана» её называет;
 *  - явление без словаря показывается кодом как есть («явление UP»);
 *  - «нет группы», «не измерено» и «ноль» различаются: штиль — 0 м/с, нет
 *    ветра в сводке — null, `/////MPS` — «ветер не измерен»;
 *  - сводка NIL или без единой разобранной группы — не «погода есть», а
 *    пустота: её место занимает предыдущая настоящая сводка;
 *  - время сводки — из самой сводки (ДДЧЧММZ), а не из времени запроса.
 *
 * Это наблюдение у полосы, а не прогноз по краю и не данные для полётов.
 * Вулканический пепел в METAR: VA — над аэродромом, VCVA — в окрестностях
 * (8–16 км). Пепел над вулканами — бюллетени KVERT и VAAC, а не эта сводка.
 */

export type CloudCover = 'FEW' | 'SCT' | 'BKN' | 'OVC';

export interface MetarCloud {
  cover: CloudCover;
  /** Нижняя граница, м; null — высота в сводке не указана (`///`). */
  baseM: number | null;
  /** Кучево-дождевые (CB) или мощные кучевые (TCU). */
  convective: 'CB' | 'TCU' | null;
}

export interface Metar {
  raw: string;
  station: string;
  /** ISO UTC — время наблюдения из группы ДДЧЧММZ; null — группы нет. */
  observedAt: string | null;
  /** NIL — сводка выпущена пустой. */
  nil: boolean;
  /** Направление, откуда дует, градусы; null — переменный или не указан. */
  windDirDeg: number | null;
  windVariable: boolean;
  /** Средняя скорость, м/с; 0 — штиль; null — ветра в сводке нет или он не измерен. */
  windMps: number | null;
  gustMps: number | null;
  /** Группа ветра есть, но прибор не дал значения (`/////MPS`). */
  windMissing: boolean;
  /** Преобладающая видимость, м; 10000 при `9999` и CAVOK — «10 км и более». */
  visibilityM: number | null;
  cavok: boolean;
  /** Коды явлений как в сводке: «-SN», «BR», «+SHRA». */
  weather: string[];
  clouds: MetarCloud[];
  /** Группа VV есть: небо не видно. */
  skyObscured: boolean;
  /** Вертикальная видимость, м; null — не указана (`VV///`) или группы нет. */
  verticalVisibilityM: number | null;
  /** NSC / NCD / SKC / CLR — облаков, о которых стоит сказать, нет. */
  noSignificantCloud: boolean;
  /** Сдвиг ветра: полосы («34L») или «ALL» — на всех; пустая строка — полоса не названа. */
  windShear: string[];
  /** SNOCLO — аэродром закрыт из-за снега. */
  closedBySnow: boolean;
  tempC: number | null;
  dewC: number | null;
  qnhHpa: number | null;
  /** Группы из одних «/» — значение не измерено (часто у автоматических сводок). */
  notMeasured: number;
  /** Группы основной части, которые разбор не знает. */
  unparsed: string[];
}

const KT_TO_MPS = 0.514444;
const FT_TO_M = 0.3048;

function signedTemp(s: string): number {
  return s.startsWith('M') ? -Number(s.slice(1)) : Number(s);
}

/** Сотни футов → метры, до десятка. */
function hundredsFtToM(s: string): number {
  return Math.round((Number(s) * 100 * FT_TO_M) / 10) * 10;
}

/**
 * Время ДДЧЧММZ в ISO UTC. Месяца и года в сводке нет: берётся тот месяц,
 * при котором сводка ближе всего к «сейчас» (на рубеже месяца день 31 —
 * это прошлый месяц).
 */
export function metarTime(ddhhmm: string, now: Date): string | null {
  const m = /^(\d{2})(\d{2})(\d{2})Z$/.exec(ddhhmm);
  if (!m) return null;
  const [d, h, mi] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (d < 1 || d > 31 || h > 23 || mi > 59) return null;
  let best: number | null = null;
  for (const shift of [-1, 0, 1]) {
    const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + shift, 1));
    const ms = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), d, h, mi);
    // День 31 в тридцатидневном месяце Date.UTC переносит в следующий — такой месяц не годится.
    if (new Date(ms).getUTCDate() !== d) continue;
    if (best === null || Math.abs(ms - now.getTime()) < Math.abs(best - now.getTime())) best = ms;
  }
  return best === null ? null : new Date(best).toISOString();
}

const WEATHER_RE = /^(\+|-|VC)?(MI|BC|PR|DR|BL|SH|TS|FZ)?((?:DZ|RA|SN|SG|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PO|SQ|FC|SS|DS)+)$|^(\+|-|VC)?(TS|SH)$/;

/** Разбор одной сводки. Пустая строка или чужой формат — null. */
export function parseMetar(rawInput: string, now: Date): Metar | null {
  const raw = rawInput.trim().replace(/=$/, '').replace(/\s+/g, ' ');
  const tokens = raw.split(' ');
  let i = 0;
  while (i < tokens.length && /^(METAR|SPECI|COR)$/.test(tokens[i])) i++;
  const station = tokens[i];
  if (!station || !/^[A-Z]{4}$/.test(station)) return null;
  i++;

  const out: Metar = {
    raw, station, observedAt: null, nil: false,
    windDirDeg: null, windVariable: false, windMps: null, gustMps: null, windMissing: false,
    visibilityM: null, cavok: false, weather: [], clouds: [],
    skyObscured: false, verticalVisibilityM: null, noSignificantCloud: false,
    windShear: [], closedBySnow: false,
    tempC: null, dewC: null, qnhHpa: null, notMeasured: 0, unparsed: [],
  };

  for (; i < tokens.length; i++) {
    const t = tokens[i];
    // Тренд и примечания — не наблюдение «сейчас»: основная часть кончилась.
    if (/^(NOSIG|BECMG|TEMPO|RMK)$/.test(t)) break;
    if (t === 'COR' || t === 'AUTO') continue;
    if (t === 'NIL') { out.nil = true; continue; }
    let m: RegExpExecArray | null;
    if (out.observedAt === null && /^\d{6}Z$/.test(t)) {
      out.observedAt = metarTime(t, now);
      continue;
    }
    if ((m = /^(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?(MPS|KT)$/.exec(t))) {
      const k = m[4] === 'KT' ? KT_TO_MPS : 1;
      out.windVariable = m[1] === 'VRB';
      out.windDirDeg = out.windVariable ? null : Number(m[1]);
      out.windMps = Math.round(Number(m[2]) * k);
      out.gustMps = m[3] ? Math.round(Number(m[3]) * k) : null;
      continue;
    }
    if (/^[\dVRB/]{5,6}(G[\d/]{2,3})?(MPS|KT)$/.test(t) && t.includes('/')) { out.windMissing = true; continue; }
    if (/^\d{3}V\d{3}$/.test(t)) continue; // разброс направления — средняя уже записана
    if (t === 'CAVOK') { out.cavok = true; out.visibilityM = 10000; continue; }
    if (out.visibilityM === null && (m = /^(\d{4})(?:NDV)?$/.exec(t))) {
      out.visibilityM = m[1] === '9999' ? 10000 : Number(m[1]);
      continue;
    }
    if (/^\d{4}(N|NE|E|SE|S|SW|W|NW)$/.test(t)) continue; // наименьшая видимость по сектору
    if (/^(R(\d{2}[LCR]?)?\/)?SNOCLO$/.test(t)) { out.closedBySnow = true; continue; }
    if (/^R\d{2}[LCR]?\//.test(t)) continue; // дальность на полосе и состояние полосы
    if (t === 'WS') {
      // «WS R34L» — сдвиг ветра на полосе, «WS ALL RWY» — на всех.
      const next = tokens[i + 1] ?? '';
      const rwy = /^R(\d{2}[LCR]?)$/.exec(next);
      if (rwy) { out.windShear.push(rwy[1]); i += 1; }
      else if (next === 'ALL' && tokens[i + 2] === 'RWY') { out.windShear.push('ALL'); i += 2; }
      else out.windShear.push('');
      continue;
    }
    if (/^RE[A-Z]+$/.test(t)) continue; // недавние явления — не «сейчас»
    if (WEATHER_RE.test(t)) { out.weather.push(t); continue; }
    if ((m = /^(FEW|SCT|BKN|OVC)(\d{3}|\/\/\/)(CB|TCU|\/\/\/)?$/.exec(t))) {
      out.clouds.push({
        cover: m[1] as CloudCover,
        baseM: m[2] === '///' ? null : hundredsFtToM(m[2]),
        convective: m[3] === 'CB' || m[3] === 'TCU' ? m[3] : null,
      });
      continue;
    }
    if (/^(NSC|NCD|SKC|CLR)$/.test(t)) { out.noSignificantCloud = true; continue; }
    if ((m = /^VV(\d{3}|\/\/\/)$/.exec(t))) {
      out.skyObscured = true;
      out.verticalVisibilityM = m[1] === '///' ? null : hundredsFtToM(m[1]);
      continue;
    }
    if ((m = /^(M?\d{2})\/(M?\d{2})?$/.exec(t))) {
      out.tempC = signedTemp(m[1]);
      out.dewC = m[2] ? signedTemp(m[2]) : null;
      continue;
    }
    if ((m = /^Q(\d{4})$/.exec(t))) { out.qnhHpa = Number(m[1]); continue; }
    if (/^A\d{4}$/.test(t)) continue; // давление в дюймах — у нас есть Q
    if (t === 'NSW') continue;
    if (/^\/+$/.test(t)) { out.notMeasured += 1; continue; }
    out.unparsed.push(t);
  }
  return out;
}

/** Есть ли в сводке хоть что-то разобранное о погоде. NIL и пустая AUTO — нет. */
export function hasObservation(m: Metar): boolean {
  if (m.nil) return false;
  return m.windMps !== null || m.visibilityM !== null || m.cavok || m.weather.length > 0
    || m.clouds.length > 0 || m.skyObscured || m.noSignificantCloud || m.closedBySnow
    || m.windShear.length > 0 || m.tempC !== null;
}

// ── Словами ──────────────────────────────────────────────────────────────

type Gender = 'm' | 'f' | 'n' | 'pl';

/** Явление без интенсивности: слова и род — для «слабый снег», «слабая морось». */
const PHENOMENA: Record<string, { words: string; g: Gender }> = {
  DZ: { words: 'морось', g: 'f' },
  RA: { words: 'дождь', g: 'm' },
  SN: { words: 'снег', g: 'm' },
  SG: { words: 'снежные зёрна', g: 'pl' },
  PL: { words: 'ледяная крупа', g: 'f' },
  GR: { words: 'град', g: 'm' },
  GS: { words: 'снежная крупа', g: 'f' },
  RASN: { words: 'дождь со снегом', g: 'm' },
  SNRA: { words: 'снег с дождём', g: 'm' },
  DZRA: { words: 'морось с дождём', g: 'f' },
  SHRA: { words: 'ливневый дождь', g: 'm' },
  SHSN: { words: 'ливневый снег', g: 'm' },
  SHRASN: { words: 'ливневый дождь со снегом', g: 'm' },
  SHSNRA: { words: 'ливневый снег с дождём', g: 'm' },
  SHGS: { words: 'снежная крупа', g: 'f' },
  SHGR: { words: 'град', g: 'm' },
  FZRA: { words: 'ледяной дождь', g: 'm' },
  FZDZ: { words: 'ледяная морось', g: 'f' },
  SH: { words: 'ливень', g: 'm' },
  BLSN: { words: 'метель', g: 'f' },
  DRSN: { words: 'позёмок', g: 'm' },
  BR: { words: 'дымка', g: 'f' },
  FG: { words: 'туман', g: 'm' },
  FZFG: { words: 'переохлаждённый туман', g: 'm' },
  BCFG: { words: 'туман клочьями', g: 'm' },
  MIFG: { words: 'поземный туман', g: 'm' },
  PRFG: { words: 'частичный туман', g: 'm' },
  HZ: { words: 'мгла', g: 'f' },
  FU: { words: 'дым', g: 'm' },
  VA: { words: 'вулканический пепел', g: 'm' },
  DU: { words: 'пыль', g: 'f' },
  SA: { words: 'песок', g: 'm' },
  SQ: { words: 'шквал', g: 'm' },
  FC: { words: 'смерч', g: 'm' },
  SS: { words: 'песчаная буря', g: 'f' },
  DS: { words: 'пыльная буря', g: 'f' },
};

const WEAK: Record<Gender, string> = { m: 'слабый', f: 'слабая', n: 'слабое', pl: 'слабые' };
const STRONG: Record<Gender, string> = { m: 'сильный', f: 'сильная', n: 'сильное', pl: 'сильные' };
/** VC — явление в окрестностях аэродрома, 8–16 км, а не над ним. */
const VICINITY = 'в окрестностях аэродрома (8–16 км)';

function withIntensity(p: { words: string; g: Gender }, intensity: string): string {
  if (intensity === '-') return `${WEAK[p.g]} ${p.words}`;
  if (intensity === '+') return `${STRONG[p.g]} ${p.words}`;
  return p.words;
}

/**
 * «-SHSN» → «слабый ливневый снег»; незнакомый код — «явление UP», без догадки.
 *
 * Знак у грозы с осадками относится к осадкам, а не к грозе: «-TSRA» — это
 * гроза и слабый дождь, а не «слабая гроза». Пепел без VC — над аэродромом,
 * с VC — в окрестностях.
 */
export function weatherWords(code: string): string {
  const m = /^(\+|-|VC)?(.+)$/.exec(code);
  const intensity = m?.[1] ?? '';
  const base = m?.[2] ?? code;
  if (base === 'TS') return intensity === 'VC' ? `гроза ${VICINITY}` : 'гроза';
  if (base.startsWith('TS')) {
    const precip = PHENOMENA[base.slice(2)];
    if (!precip) return `явление ${code}`;
    return intensity === 'VC' ? `гроза ${VICINITY}` : `гроза, ${withIntensity(precip, intensity)}`;
  }
  const p = PHENOMENA[base];
  if (!p) return `явление ${code}`;
  if (intensity === 'VC') return `${p.words} ${VICINITY}`;
  if (base === 'VA') return `${withIntensity(p, intensity)} над аэродромом`;
  return withIntensity(p, intensity);
}

const COMPASS = ['северный', 'северо-восточный', 'восточный', 'юго-восточный', 'южный', 'юго-западный', 'западный', 'северо-западный'];

export function windWords(w: Pick<Metar, 'windDirDeg' | 'windVariable' | 'windMps' | 'gustMps' | 'windMissing'>): string | null {
  if (w.windMps === null) return w.windMissing ? 'ветер не измерен' : null;
  if (w.windMps === 0 && !w.gustMps) return 'штиль';
  const dir = w.windVariable || w.windDirDeg === null
    ? 'переменный'
    : COMPASS[Math.round(w.windDirDeg / 45) % 8];
  return `ветер ${dir} ${w.windMps} м/с${w.gustMps ? `, порывы ${w.gustMps}` : ''}`;
}

export function visibilityWords(v: number | null): string | null {
  if (v === null) return null;
  if (v >= 10000) return 'видимость 10 км и более';
  if (v >= 5000) return `видимость ${Math.round(v / 1000)} км`;
  return `видимость ${v} м`;
}

/** Количество облаков словами, как в расшифровке METAR по-русски. */
const COVER_WORDS: Record<CloudCover, string> = {
  FEW: 'незначительная',
  SCT: 'рассеянная',
  BKN: 'значительная',
  OVC: 'сплошная',
};

function layerWords(c: MetarCloud): string {
  const base = c.baseM === null ? ', высота не указана' : ` от ${c.baseM} м`;
  const conv = c.convective === 'CB' ? ', кучево-дождевые' : c.convective === 'TCU' ? ', мощные кучевые' : '';
  return `${COVER_WORDS[c.cover]}${base}${conv}`;
}

/**
 * Облачность слоями, снизу вверх, каждый — своим количеством и высотой:
 * «облачность: незначительная от 1220 м, кучево-дождевые; значительная от
 * 2190 м». Один «потолок» без слоёв прятал бы то, что ниже него.
 */
export function cloudWords(m: Metar): string | null {
  if (m.cavok) return 'видимость 10 км и более, облаков ниже 1500 м и явлений погоды нет';
  if (m.skyObscured) {
    return m.verticalVisibilityM === null
      ? 'небо не видно, вертикальная видимость не указана'
      : `небо не видно, вертикальная видимость ${m.verticalVisibilityM} м`;
  }
  if (m.clouds.length > 0) {
    const layers = [...m.clouds].sort((a, b) => (a.baseM ?? Infinity) - (b.baseM ?? Infinity));
    return `облачность: ${layers.map(layerWords).join('; ')}`;
  }
  if (m.noSignificantCloud) return 'существенной облачности нет';
  return null;
}

function tempWords(t: number | null): string | null {
  if (t === null) return null;
  return `${t < 0 ? '−' : ''}${Math.abs(t)} °C`;
}

function windShearWords(rwys: string[]): string | null {
  if (rwys.length === 0) return null;
  if (rwys.includes('ALL')) return 'сдвиг ветра на всех полосах';
  const named = rwys.filter(Boolean);
  return named.length ? `сдвиг ветра на полосе ${named.join(', ')}` : 'сдвиг ветра';
}

/**
 * Строки сводки для человека: закрытие аэродрома, ветер, сдвиг ветра,
 * видимость, явления, облачность, температура — и что в сводке не измерено
 * или не разобрано, чтобы список не читался полным, когда он не полон.
 */
export function metarLines(m: Metar): string[] {
  return [
    m.closedBySnow ? 'аэродром закрыт из-за снега' : null,
    windWords(m),
    windShearWords(m.windShear),
    m.cavok ? null : visibilityWords(m.visibilityM),
    ...m.weather.map(weatherWords),
    cloudWords(m),
    tempWords(m.tempC),
    m.notMeasured > 0 ? 'часть значений в сводке не измерена («///»)' : null,
    m.unparsed.length > 0 ? `часть сводки не разобрана: ${m.unparsed.join(' ')}` : null,
  ].filter((s): s is string => Boolean(s));
}

// ── Загрузка ─────────────────────────────────────────────────────────────

/** Аэродром Елизово (Петропавловск-Камчатский). */
export const UHPP = 'UHPP';
/**
 * NOAA Aviation Weather Center: сводки всех аэродромов мира, без ключа.
 * Формат raw — сам код ВМО построчно: он не зависит от того, как AWC
 * переименует поля JSON. С прода (РФ) доступен — prod-check 158, 29.10.
 */
export const AWC_METAR_URL = `https://aviationweather.gov/api/data/metar?ids=${UHPP}&format=raw&hours=3`;
/** Новее этого сводка «сейчас» — АМСГ выпускает её каждые полчаса. */
export const METAR_STALE_MIN = 90;

export type MetarRead =
  | { kind: 'ok'; metar: Metar; stale: boolean }
  | { kind: 'none'; reason: string }
  | { kind: 'failed'; reason: string };

const METAR_TTL_MS = 5 * 60 * 1000;
const METAR_FAIL_TTL_MS = 60 * 1000;
const METAR_TIMEOUT_MS = 8_000;
/** Свой агент, как у табло: под поисковик не маскируемся. */
const METAR_UA = 'Mozilla/5.0 (compatible; VedarBot/1.0; +https://vedarai.ru)';

let metarCache: { read: MetarRead; expiresAt: number } | null = null;
/** Запрос в пути: одновременные заходы ждут его, а не шлют каждый свой. */
let metarInFlight: Promise<MetarRead> | null = null;

/**
 * Самая свежая сводка аэродрома, в которой есть погода. Строки не по
 * аэродрому и не сводки — мимо; NIL и пустые — тоже мимо, но считаются:
 * «сводки были, все пустые» и «сводок не было» — разные исходы.
 */
export function latestMetar(text: string, station: string, now: Date): { metar: Metar | null; empty: number } {
  let best: Metar | null = null;
  let empty = 0;
  for (const line of text.split('\n')) {
    const m = parseMetar(line, now);
    if (!m || m.station !== station || !m.observedAt) continue;
    if (!hasObservation(m)) { empty += 1; continue; }
    if (!best || Date.parse(m.observedAt) > Date.parse(best.observedAt as string)) best = m;
  }
  return { metar: best, empty };
}

async function fetchAirportMetar(now: Date, fetchImpl: typeof fetch): Promise<MetarRead> {
  try {
    const res = await fetchImpl(AWC_METAR_URL, {
      headers: { 'user-agent': METAR_UA, accept: 'text/plain' },
      signal: AbortSignal.timeout(METAR_TIMEOUT_MS),
    });
    if (!res.ok) return { kind: 'failed', reason: `сервис сводок ответил HTTP ${res.status}` };
    const text = await res.text();
    const { metar, empty } = latestMetar(text, UHPP, now);
    if (metar) {
      const ageMin = (now.getTime() - Date.parse(metar.observedAt as string)) / 60_000;
      return { kind: 'ok', metar, stale: ageMin > METAR_STALE_MIN };
    }
    if (empty > 0) return { kind: 'none', reason: 'сводки аэродрома за три часа пришли пустыми (NIL)' };
    if (text.trim() === '') return { kind: 'none', reason: 'за три часа сводок аэродрома нет' };
    return { kind: 'failed', reason: 'ответ сервиса — не сводка METAR' };
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    return { kind: 'failed', reason: `сервис сводок не ответил (${reason})` };
  }
}

/** Сводка Елизово: удачная помнится 5 минут, отказ — минуту. */
export async function loadAirportMetar(now: Date = new Date(), fetchImpl: typeof fetch = fetch): Promise<MetarRead> {
  if (metarCache && metarCache.expiresAt > now.getTime()) return metarCache.read;
  if (metarInFlight) return metarInFlight;
  metarInFlight = fetchAirportMetar(now, fetchImpl).then((read) => {
    if (read.kind !== 'ok') console.error(`[metar] ${UHPP}: ${read.reason}`);
    metarCache = { read, expiresAt: now.getTime() + (read.kind === 'ok' ? METAR_TTL_MS : METAR_FAIL_TTL_MS) };
    return read;
  }).finally(() => { metarInFlight = null; });
  return metarInFlight;
}

/** Для тестов: забыть сводку. */
export function resetMetarCache(): void {
  metarCache = null;
  metarInFlight = null;
}
