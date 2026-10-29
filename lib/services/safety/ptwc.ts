/**
 * PTWC — тихоокеанский центр предупреждения о цунами (NWS, Гонолулу) как
 * ДОПОЛНИТЕЛЬНОЕ подтверждение угрозы цунами побережью Камчатки (карт-бланш
 * владельца 29.10 на бесплатные источники; проба 1009–1012).
 *
 * Чем это НЕ является: не источник тревоги `tsunami_warning` и не её
 * отмена. Официальная тревога для края идёт от МЧС/КФ ЕГС через safety-ingest;
 * PTWC — международное сообщение «для национальных властей», и оно само так
 * себя называет. Здесь оно служит одному: заметить, что PTWC считает волну
 * у берегов края возможной, а в нашей ленте официальной тревоги нет, — и
 * разбудить дежурного. Туристу PTWC не показывается, и отсутствие PTWC
 * ничего не значит.
 *
 * Форма данных (сверено с прода и с архивом 29.07.2025):
 *   индекс  https://www.tsunami.gov/events/json/PHEBWEPA40.json — последний
 *           бюллетень слота WEPA40 (Тихий океан): eventDir, номер бюллетеня,
 *           время выпуска, магнитуда, эпицентр. JSON у них местами невалидный
 *           («"eventLat" : 28.,») — чинится до разбора;
 *   текст   https://www.tsunami.gov<eventDir>WEPA40.txt — само сообщение:
 *           «TSUNAMI THREAT MESSAGE» / информационное, прогноз высот по
 *           странам, таблица расчётного прихода волны (ETA) с координатами.
 *
 * Относится ли угроза к краю — решают СТРОКИ ТАБЛИЦЫ ETA с координатами
 * внутри конверта края (`insideKrai`), а не слово «RUSSIA»: у PTWC к России
 * относятся и Уруп (46.1N), и Гастелло на Сахалине (49.1N). Времена ETA
 * даны в UTC; дежурному они называются и по Камчатке (UTC+12).
 *
 * Достижимость (что измерено, а что нет). Индекс, Atom и CAP с ПРОДА отвечают
 * 200 (prod-check 158, source-probe). Текст бюллетеня по адресу из eventDir
 * с раннера GitHub отвечает 200 у текущего события (проба 1008, слот WEGM42)
 * и 403 у архива прошлых лет (проба 1010) — поэтому образцы для разбора
 * взяты из архива weather.gov (.docx, пробы 1011–1012). С прода текст
 * бюллетеня ещё не читался: первый живой бюллетень это и покажет — отказ
 * похода здесь 502 и `failed`, а не «угрозы нет».
 *
 * Бюллетени во время события идут примерно раз в час, и каждый новый —
 * новое сообщение дежурному, пока официальной тревоги в ленте нет: само
 * расхождение не устарело, и повтор — напоминание о нём, а не шум.
 */
import { insideKrai } from '@/lib/geo/krai-envelope';

export const PTWC_BASE = 'https://www.tsunami.gov';
export const PTWC_INDEX_URL = `${PTWC_BASE}/events/json/PHEBWEPA40.json`;
/** Бюллетень старше этого — прошлое событие, а не сегодняшняя обстановка. */
export const PTWC_FRESH_HOURS = 24;
const UA = 'VedarBot/1.0 (+https://vedarai.ru)';
const TIMEOUT_MS = 8_000;

export interface PtwcIndex {
  eventDir: string;
  twcEventId: string;
  bulletinNr: number;
  /** Время выпуска бюллетеня, ISO UTC. */
  issuedAt: string;
  originTime: string | null;
  magnitude: number | null;
  lat: number | null;
  lon: number | null;
  location: string | null;
  messageUrl: string;
}

export type PtwcBand = 'gt3' | '1to3' | '0.3to1' | 'lt0.3';

export const PTWC_BAND_WORDS: Record<PtwcBand, string> = {
  gt3: 'более 3 м',
  '1to3': '1–3 м',
  '0.3to1': '0,3–1 м',
  'lt0.3': 'менее 0,3 м',
};

export interface PtwcEta {
  name: string;
  region: string;
  lat: number;
  lon: number;
  /** Расчётный приход начальной волны, ISO UTC; null — год взять неоткуда (точка остаётся: край решают координаты). */
  etaAt: string | null;
}

export interface PtwcMessage {
  kind: 'threat' | 'information' | 'unknown';
  messageNumber: number | null;
  issuedAt: string | null;
  magnitude: number | null;
  originTime: string | null;
  location: string | null;
  /** «THREAT HAS PASSED» / «FINAL» — угроза снята самим центром. */
  threatPassed: boolean;
  /** Высота волны, прогнозируемая для берегов России; null — Россия в полосах не названа. */
  russiaBand: PtwcBand | null;
  /** Первое сообщение без высот: «HAZARDOUS TSUNAMI WAVES … ALONG SOME COASTS OF RUSSIA AND JAPAN». */
  russiaPreliminary: boolean;
  etas: PtwcEta[];
  /** Строки ETA внутри конверта края. */
  kraiPoints: PtwcEta[];
}

const MONTHS: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

/** «0016 UTC WED JUL 30 2025» или «2325 UTC JUL 29 2025» → ISO; не разобрано — null. */
export function ptwcTime(text: string): string | null {
  const m = /(\d{2})(\d{2}) UTC (?:[A-Z]{3} )?([A-Z]{3}) (\d{1,2}) (\d{4})/.exec(text);
  if (!m) return null;
  const mon = MONTHS[m[3]];
  if (mon === undefined) return null;
  const t = Date.UTC(Number(m[5]), mon, Number(m[4]), Number(m[1]), Number(m[2]));
  const d = new Date(t);
  if (d.getUTCMonth() !== mon || d.getUTCDate() !== Number(m[4]) || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return d.toISOString();
}

/**
 * Индекс слота. JSON PTWC невалиден там, где координата целая («28.,»):
 * точка без дробной части перед запятой или скобкой дописывается нулём.
 */
export function parsePtwcIndex(text: string): PtwcIndex | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/(\d)\.(?=\s*[,}\]])/g, '$1.0'));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const eventDir = typeof o.eventDir === 'string' ? o.eventDir : null;
  const twcEventId = typeof o.twcEventID === 'string' ? o.twcEventID : null;
  const bulletinNr = Number(o.bulletinNr);
  const issued = typeof o.bulletinIssueTime === 'string' ? Date.parse(o.bulletinIssueTime) : NaN;
  if (!eventDir || !twcEventId || !Number.isFinite(bulletinNr) || !Number.isFinite(issued)) return null;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const origin = typeof o.originTime === 'string' && Number.isFinite(Date.parse(o.originTime))
    ? new Date(o.originTime).toISOString() : null;
  return {
    eventDir,
    twcEventId,
    bulletinNr,
    issuedAt: new Date(issued).toISOString(),
    originTime: origin,
    magnitude: num(o.eventMagnitude),
    lat: num(o.eventLat),
    lon: num(o.eventLon),
    location: typeof o.quakeLocation === 'string' && o.quakeLocation.trim() ? o.quakeLocation.trim() : null,
    messageUrl: `${PTWC_BASE}${eventDir.endsWith('/') ? eventDir : `${eventDir}/`}WEPA40.txt`,
  };
}

const BAND_PATTERNS: Array<[PtwcBand, RegExp]> = [
  ['gt3', /MORE THAN 3 METERS/],
  ['1to3', /1 TO 3 METERS/],
  ['0.3to1', /0\.3 TO 1 METERS/],
  ['lt0.3', /LESS THAN 0\.3 METERS/],
];

function countriesOf(bullet: string): string[] {
  const at = bullet.search(/COASTS OF/);
  if (at < 0) return [];
  return bullet.slice(at + 'COASTS OF'.length)
    .replace(/\.$/, '')
    .split(/\.\.\.|\bAND\b/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Текст сообщения PTWC → разобранные поля. Чего в тексте нет — null или
 * пусто, не догадка. `fallbackIssuedAt` — время выпуска из индекса: по нему
 * датируются строки ETA, когда шапка сообщения не разобралась.
 */
export function parsePtwcMessage(text: string, fallbackIssuedAt: string | null = null): PtwcMessage {
  const lines = text.replace(/\r/g, '').split('\n').map((l) => l.trim());
  const body = lines.join('\n');
  // Берём только первое сообщение, если в файле их несколько (архивы шьют подряд).
  const first = body.split(/\n\$\$\n/)[0] ?? body;

  const kind: PtwcMessage['kind'] = /\.\.\.PTWC TSUNAMI THREAT MESSAGE\.\.\./.test(first)
    ? 'threat'
    : /TSUNAMI INFORMATION STATEMENT/.test(first) ? 'information' : 'unknown';
  const messageNumber = Number(/TSUNAMI MESSAGE NUMBER (\d+)/.exec(first)?.[1]);
  const headerTime = /^\d{4} UTC .+\d{4}$/m.exec(first)?.[0] ?? '';
  const magnitude = Number(/\* MAGNITUDE (\d+(?:\.\d+)?)/.exec(first)?.[1]);
  const origin = /\* ORIGIN TIME (\d{4} UTC [A-Z]{3} \d{1,2} \d{4})/.exec(first)?.[1] ?? '';
  const location = /\* LOCATION (.+)/.exec(first)?.[1]?.trim() ?? null;
  // Снятие угрозы — только словами о самой угрозе. «FINAL MESSAGE» сюда не
  // входит: «это последнее сообщение» бывает и у бюллетеня с живыми ETA.
  const threatPassed = /THREAT HAS (?:NOW )?(?:LARGELY )?PASSED|NO (?:LONGER|FURTHER) (?:A )?(?:TSUNAMI )?THREAT/.test(first);

  // Прогноз высот: раздел между «TSUNAMI THREAT FORECAST» и «RECOMMENDED ACTIONS».
  const fcStart = first.search(/TSUNAMI THREAT FORECAST/);
  const fcEnd = first.search(/RECOMMENDED ACTIONS/);
  const forecast = fcStart >= 0 ? first.slice(fcStart, fcEnd > fcStart ? fcEnd : undefined) : '';
  const bullets = forecast.split(/\n\* /).slice(1).map((b) => b.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim());
  let russiaBand: PtwcBand | null = null;
  let russiaPreliminary = false;
  for (const b of bullets) {
    const band = BAND_PATTERNS.find(([, re]) => re.test(b))?.[0];
    const countries = countriesOf(b);
    if (!countries.includes('RUSSIA')) continue;
    if (band) russiaBand = russiaBand ?? band;
    else if (/HAZARDOUS TSUNAMI WAVES/.test(b)) russiaPreliminary = true;
  }

  // Таблица ETA: «PETROPAVLOVSK RUSSIA 53.2N 159.6E 2358 07/29».
  const etas: PtwcEta[] = [];
  const issuedAt = headerTime ? ptwcTime(headerTime) : null;
  const rowRe = /^([A-Z][A-Z .'-]*?)\s+(\d+\.\d)([NS])\s+(\d+\.\d)([EW])\s+(\d{2})(\d{2})\s+(\d{2})\/(\d{2})$/;
  for (const line of first.split('\n')) {
    const m = rowRe.exec(line);
    if (!m) continue;
    const lat = Number(m[2]) * (m[3] === 'S' ? -1 : 1);
    const lon = Number(m[4]) * (m[5] === 'W' ? -1 : 1);
    // Строка без даты не выбрасывается: край решают координаты, а не год.
    const etaAt = etaIso(issuedAt ?? fallbackIssuedAt, Number(m[8]), Number(m[9]), Number(m[6]), Number(m[7]));
    const [name, region] = splitNameRegion(m[1]);
    etas.push({ name, region, lat, lon, etaAt });
  }
  const kraiPoints = etas.filter((e) => insideKrai(e.lat, e.lon) === true);

  return {
    kind,
    messageNumber: Number.isFinite(messageNumber) ? messageNumber : null,
    issuedAt,
    magnitude: Number.isFinite(magnitude) ? magnitude : null,
    originTime: origin ? ptwcTime(origin) : null,
    location,
    threatPassed,
    russiaBand,
    russiaPreliminary,
    etas,
    kraiPoints,
  };
}

/**
 * Регионы таблицы ETA из нескольких слов — как PTWC их печатает (колонка
 * в 16 знаков, поэтому «NORTHERN MARIANA», «WALLIS AND FUTUN»). Нужны
 * только чтобы отделить имя точки от региона, когда колонки схлопнулись в
 * одиночные пробелы; край решают координаты, а не эти слова.
 */
const MULTIWORD_REGIONS = [
  'NEW ZEALAND', 'NEW CALEDONIA', 'MARSHALL ISLANDS', 'SOLOMON ISLANDS', 'PAPUA NEW GUINEA',
  'COOK ISLANDS', 'FRENCH POLYNESIA', 'NORTHWEST HAWAII', 'NORTHERN MARIANA', 'AMERICAN SAMOA',
  'WALLIS AND FUTUN', 'HOWLAND AND BAKE', 'EL SALVADOR', 'COSTA RICA', 'MIDWAY ISLAND',
  'WAKE ISLAND', 'JOHNSTON ISLAND', 'PALMYRA ISLAND', 'JARVIS ISLAND', 'KERMADEC ISLANDS',
  'DPR OF KOREA', 'REPUBLIC OF KOREA', 'PITCAIRN ISLANDS',
];

/**
 * «UST KAMCHATSK RUSSIA» → имя и регион. В файле .txt колонки фиксированной
 * ширины — тогда делим по двум и более пробелам; схлопнутые (как в архиве
 * .docx) — по известному многословному региону, иначе регион — последнее слово.
 */
export function splitNameRegion(head: string): [string, string] {
  const wide = head.trim().split(/\s{2,}/);
  if (wide.length >= 2) return [wide[0], wide.slice(1).join(' ')];
  const flat = head.trim().replace(/\s+/g, ' ');
  for (const region of MULTIWORD_REGIONS) {
    if (flat.endsWith(` ${region}`)) return [flat.slice(0, -region.length - 1), region];
  }
  const at = flat.lastIndexOf(' ');
  return at < 0 ? [flat, ''] : [flat.slice(0, at), flat.slice(at + 1)];
}

/**
 * Год у ETA не напечатан: берётся от времени выпуска; приход в январе при
 * выпуске в декабре — следующий год. Без времени выпуска год взять неоткуда.
 */
function etaIso(issuedAt: string | null, month: number, day: number, hh: number, mm: number): string | null {
  if (!issuedAt || month < 1 || month > 12 || day < 1 || day > 31 || hh > 23 || mm > 59) return null;
  const issued = new Date(issuedAt);
  let year = issued.getUTCFullYear();
  if (month === 1 && issued.getUTCMonth() === 11) year += 1;
  const d = new Date(Date.UTC(year, month - 1, day, hh, mm));
  return d.getUTCMonth() === month - 1 ? d.toISOString() : null;
}

export type PtwcVerdict = 'threat_to_krai' | 'passed' | 'no_krai_threat' | 'stale';

/**
 * Что бюллетень значит для края. `stale` — старше PTWC_FRESH_HOURS (прошлое
 * событие); `passed` — центр сам снял угрозу; `threat_to_krai` — сообщение об
 * угрозе с точками края в таблице прихода; иначе края оно не касается.
 */
export function ptwcVerdict(index: PtwcIndex, message: PtwcMessage | null, now: Date): PtwcVerdict {
  if (now.getTime() - Date.parse(index.issuedAt) > PTWC_FRESH_HOURS * 3_600_000) return 'stale';
  if (!message || message.kind !== 'threat') return 'no_krai_threat';
  if (message.threatPassed) return 'passed';
  return message.kraiPoints.length > 0 ? 'threat_to_krai' : 'no_krai_threat';
}

export type PtwcRead =
  | { kind: 'ok'; index: PtwcIndex; message: PtwcMessage | null; verdict: PtwcVerdict }
  | { kind: 'failed'; reason: string; index: PtwcIndex | null };

async function fetchText(url: string, fetchImpl: typeof fetch): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  try {
    const res = await fetchImpl(url, {
      headers: { 'user-agent': UA, accept: 'application/json, text/plain, */*' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status} ${url}` };
    return { ok: true, text: await res.text() };
  } catch (err: unknown) {
    return { ok: false, reason: `${err instanceof Error ? err.message : String(err)} ${url}` };
  }
}

/**
 * Последний бюллетень слота. Текст сообщения читается только у свежего
 * бюллетеня: у старого вердикт `stale` без второго похода. Отказ любого из
 * двух походов — `failed` с причиной: «не прочитали» не равно «угрозы нет».
 */
export async function loadPtwcLatest(fetchImpl: typeof fetch = fetch, now: Date = new Date()): Promise<PtwcRead> {
  const idx = await fetchText(PTWC_INDEX_URL, fetchImpl);
  if (!idx.ok) return { kind: 'failed', reason: idx.reason, index: null };
  const index = parsePtwcIndex(idx.text);
  if (!index) return { kind: 'failed', reason: 'индекс PTWC не разобран (не JSON слота или нет eventDir/bulletinIssueTime)', index: null };
  if (ptwcVerdict(index, null, now) === 'stale') return { kind: 'ok', index, message: null, verdict: 'stale' };
  const msg = await fetchText(index.messageUrl, fetchImpl);
  if (!msg.ok) return { kind: 'failed', reason: msg.reason, index };
  const message = parsePtwcMessage(msg.text, index.issuedAt);
  // 200 с не-бюллетенем (страница-заглушка, HTML) — «не прочитали», а не «угрозы нет».
  if (message.kind === 'unknown') {
    return { kind: 'failed', reason: `текст бюллетеня не разобран (нет «TSUNAMI MESSAGE» в ответе) ${index.messageUrl}`, index };
  }
  return { kind: 'ok', index, message, verdict: ptwcVerdict(index, message, now) };
}

const KRAI_NAMES_RU: Record<string, string> = {
  PETROPAVLOVSK: 'Петропавловск-Камчатский',
  'UST KAMCHATSK': 'Усть-Камчатск',
  'SEVERO KURILSK': 'Северо-Курильск',
  'OSTROV KARAGINS': 'о. Карагинский',
  'MEDNNY ISLAND': 'о. Медный',
};

const hm = (d: Date) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
const dm = (d: Date) => `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

/** «23:58 UTC 29.07 (11:58 по Камчатке 30.07)» — одно время в обоих поясах, с датой у каждого. */
export function utcAndKamchatka(iso: string): string {
  const utc = new Date(iso);
  const local = new Date(utc.getTime() + 12 * 3_600_000);
  return `${hm(utc)} UTC ${dm(utc)} (${hm(local)} по Камчатке ${dm(local)})`;
}

/** «Петропавловск-Камчатский 23:58 UTC 29.07 (11:58 по Камчатке 30.07)»; без даты прихода — так и сказано. */
export function etaLineRu(e: PtwcEta): string {
  const name = KRAI_NAMES_RU[e.name] ?? e.name;
  return e.etaAt ? `${name} ${utcAndKamchatka(e.etaAt)}` : `${name} (время прихода не разобрано)`;
}
