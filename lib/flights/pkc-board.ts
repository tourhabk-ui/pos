/**
 * Табло аэропорта Елизово (PKC) — с официального сайта аэропорта pkc.aero.
 *
 * Карт-бланш владельца 29.10 после вопроса «проверь задержки рейсов Елизово»
 * (issue #2788). Перебраны источники: «Яндекс Расписания» закрыты капчей для
 * машинных запросов, OpenSky анонимно отказывает и расписания не знает (без
 * расписания задержку не посчитать), агрегаторы вроде biletyplus — копия
 * табло. Первоисточник один: pkc.aero/board/ (вылет) и /board/?type=arr
 * (прилёт) отдают рейсы и статусы прямо в разметке, robots.txt их не
 * закрывает (пробы 1001–1006).
 *
 * Своей таблицы и крона нет: табло читается по запросу и держится в памяти
 * несколько минут — как прогноз у страницы погоды. Сайт аэропорта не
 * дёргается на каждый заход.
 *
 * Исходы (§4.0): табло прочитано — рейсы; не прочитано — `failed` с
 * причиной, и никто ниже не говорит «задержек нет». Разметка без строк
 * И без шапки таблицы — тоже отказ: сайт сменил вёрстку, а не опустели рейсы.
 *
 * Что берём: время и дата по расписанию, номер рейса, авиакомпания,
 * направление, статус словами табло, ожидаемое или фактическое время,
 * примечание. Позже ли рейс расписания — считаем из этих двух времён, а не
 * выводим из слова статуса: «Посадка закончена» на 1 ч 10 мин позже — тоже
 * опоздание.
 */

import { stripTags } from '@/lib/html/text';
import { decodeHtmlEntities } from '@/lib/html/entities';

export type FlightDirection = 'dep' | 'arr';

/** Род статуса — по словам табло; прочее (регистрация, посадка, ожидается) — `other`. */
export type FlightStatusKind = 'cancelled' | 'delayed' | 'other';

export interface BoardFlight {
  direction: FlightDirection;
  /** «PTK-107», как на табло. */
  flight: string;
  airline: string | null;
  /** Город назначения (вылет) или отправления (прилёт). */
  city: string;
  /** Код аэропорта, если табло его называет и это не сам Елизово. */
  cityCode: string | null;
  /** Слово табло: «Задержан», «Отменен», «Регистрация»; пусто — null. */
  status: string | null;
  statusKind: FlightStatusKind;
  /** ISO UTC; время табло — камчатское (UTC+12). */
  scheduledAt: string;
  expectedAt: string | null;
  /** На сколько минут ожидаемое/фактическое время позже расписания; null — не позже или не названо. */
  lateMinutes: number | null;
  /** «Совмещен c HZ-2653». */
  note: string | null;
}

export type BoardRead =
  | { kind: 'ok'; flights: BoardFlight[] }
  | { kind: 'failed'; reason: string };

export interface PkcBoard {
  departures: BoardRead;
  arrivals: BoardRead;
  /** Когда снято табло (ISO UTC). */
  fetchedAt: string;
}

export const PKC_BOARD_URL = 'https://pkc.aero/board/';
export const PKC_BOARD_ARR_URL = 'https://pkc.aero/board/?type=arr';
/** Справочная аэропорта — со страницы табло. */
export const PKC_INFO_PHONE = '+7 (41531) 99-999';

/** Камчатка — UTC+12 круглый год. */
const KAMCHATKA_OFFSET_MS = 12 * 60 * 60 * 1000;

/** Текст ячейки — общим разбором репозитория (lib/html/text), без своей регулярки по тегам. */
function cellText(html: string): string {
  return decodeHtmlEntities(stripTags(html, ' ')).replace(/\s+/g, ' ').trim();
}

/** Ячейки строки по номеру типа: table-flex__td--type1…7. */
function cells(rowHtml: string): Map<number, string> {
  const out = new Map<number, string>();
  const re = /table-flex__td--type(\d)[^>]*>/g;
  const marks: Array<{ type: number; start: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(rowHtml)) !== null) marks.push({ type: Number(m[1]), start: m.index + m[0].length });
  marks.forEach((mark, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].start : rowHtml.length;
    out.set(mark.type, rowHtml.slice(mark.start, end));
  });
  return out;
}

/**
 * «10:30» и «29.10» по камчатскому времени → ISO UTC. Года на табло нет:
 * берётся тот, при котором дата ближе всего к «сейчас» (табло показывает
 * вчера, сегодня и завтра; в конце декабря «01.01» — это следующий год).
 */
export function boardTime(hhmm: string, ddmm: string, now: Date): string | null {
  const t = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  const d = /^(\d{1,2})\.(\d{1,2})$/.exec(ddmm.trim());
  if (!t || !d) return null;
  const local = new Date(now.getTime() + KAMCHATKA_OFFSET_MS);
  const year = local.getUTCFullYear();
  let best: number | null = null;
  for (const y of [year - 1, year, year + 1]) {
    const ms = Date.UTC(y, Number(d[2]) - 1, Number(d[1]), Number(t[1]), Number(t[2])) - KAMCHATKA_OFFSET_MS;
    if (best === null || Math.abs(ms - now.getTime()) < Math.abs(best - now.getTime())) best = ms;
  }
  return best === null ? null : new Date(best).toISOString();
}

function timeAndDate(cellHtml: string | undefined, now: Date): string | null {
  if (!cellHtml) return null;
  const text = cellText(cellHtml);
  const m = /(\d{1,2}:\d{2})\s+(\d{1,2}\.\d{1,2})/.exec(text);
  return m ? boardTime(m[1], m[2], now) : null;
}

export function statusKind(status: string | null): FlightStatusKind {
  const s = (status ?? '').toLowerCase().replace(/ё/g, 'е');
  if (/отмен/.test(s)) return 'cancelled';
  if (/задерж/.test(s)) return 'delayed';
  return 'other';
}

/**
 * Разбор страницы табло. Строка рейса — ссылка на карточку рейса
 * (`/board/dep-…` или `/board/arr-…`) с семью ячейками. Чего в ячейке нет —
 * null, а не догадка.
 */
export function parsePkcBoard(html: string, direction: FlightDirection, now: Date): BoardRead {
  const rowRe = /<a\s+href="\/board\/(dep|arr)-[^"]*"[^>]*class="[^"]*table-flex__row[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  const flights: BoardFlight[] = [];
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html)) !== null) {
    const c = cells(m[2]);
    const flight = cellText(c.get(2) ?? '');
    const scheduledAt = timeAndDate(c.get(1), now);
    if (!flight || !scheduledAt) continue;
    const airlineAlt = /table-aircompany-logo-alt[^>]*>([\s\S]*?)<\/div>/.exec(c.get(3) ?? '');
    const airline = cellText(airlineAlt ? airlineAlt[1] : (c.get(3) ?? '')) || null;
    const placeCell = c.get(4) ?? '';
    const cityMatch = /board__text[^>]*>([\s\S]*?)<\/span>/.exec(placeCell);
    const city = cellText(cityMatch ? cityMatch[1] : placeCell);
    const codeMatch = /\b([A-Z]{3})\b/.exec(cellText(placeCell).replace(city, ''));
    const cityCode = codeMatch && codeMatch[1] !== 'PKC' ? codeMatch[1] : null;
    const status = cellText(c.get(5) ?? '') || null;
    const expectedAt = timeAndDate(c.get(6), now);
    const late = expectedAt ? Math.round((Date.parse(expectedAt) - Date.parse(scheduledAt)) / 60_000) : null;
    flights.push({
      direction,
      flight,
      airline,
      city,
      cityCode,
      status,
      statusKind: statusKind(status),
      scheduledAt,
      expectedAt,
      lateMinutes: late !== null && late > 0 ? late : null,
      note: cellText(c.get(7) ?? '') || null,
    });
  }
  if (flights.length === 0 && !/table-flex__th--type1/.test(html)) {
    return { kind: 'failed', reason: 'на странице нет таблицы табло — сайт сменил вёрстку или отдал не ту страницу' };
  }
  return { kind: 'ok', flights };
}

const BOARD_TTL_MS = 3 * 60 * 1000;
const BOARD_FAIL_TTL_MS = 60 * 1000;
const BOARD_TIMEOUT_MS = 8_000;
/** Свой агент: сайт аэропорта видит, кто читает табло (подмена под поисковик запрещена). */
const USER_AGENT = 'Mozilla/5.0 (compatible; VedarBot/1.0; +https://vedarai.ru)';

let cached: { board: PkcBoard; expiresAt: number } | null = null;

async function readOne(url: string, direction: FlightDirection, now: Date, fetchImpl: typeof fetch): Promise<BoardRead> {
  try {
    const res = await fetchImpl(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'text/html' },
      signal: AbortSignal.timeout(BOARD_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[pkc-board] ${direction}: HTTP ${res.status}`);
      return { kind: 'failed', reason: `сайт аэропорта ответил HTTP ${res.status}` };
    }
    const read = parsePkcBoard(await res.text(), direction, now);
    if (read.kind === 'failed') console.error(`[pkc-board] ${direction}: ${read.reason}`);
    return read;
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[pkc-board] ${direction}: не прочитано —`, reason);
    return { kind: 'failed', reason: `сайт аэропорта не ответил (${reason})` };
  }
}

/** Табло вылета и прилёта; удачное снятие помнится 3 минуты, отказ — минуту. */
export async function loadPkcBoard(now: Date = new Date(), fetchImpl: typeof fetch = fetch): Promise<PkcBoard> {
  if (cached && cached.expiresAt > now.getTime()) return cached.board;
  const [departures, arrivals] = await Promise.all([
    readOne(PKC_BOARD_URL, 'dep', now, fetchImpl),
    readOne(PKC_BOARD_ARR_URL, 'arr', now, fetchImpl),
  ]);
  const board: PkcBoard = { departures, arrivals, fetchedAt: now.toISOString() };
  const ok = departures.kind === 'ok' && arrivals.kind === 'ok';
  cached = { board, expiresAt: now.getTime() + (ok ? BOARD_TTL_MS : BOARD_FAIL_TTL_MS) };
  return board;
}

/** Для тестов: забыть снятое табло. */
export function resetPkcBoardCache(): void {
  cached = null;
}

/** «1 ч 25 мин», «6 дн 3 ч», «40 мин». */
export function lateWords(minutes: number): string {
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours > 0 ? `${days} дн ${hours} ч` : `${days} дн`;
  if (hours > 0) return mins > 0 ? `${hours} ч ${mins} мин` : `${hours} ч`;
  return `${mins} мин`;
}

/** Камчатские «12:55» и «29.10» из ISO UTC. */
export function kamchatkaClock(iso: string): { time: string; date: string } {
  const local = new Date(Date.parse(iso) + KAMCHATKA_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, '0');
  return {
    time: `${p(local.getUTCHours())}:${p(local.getUTCMinutes())}`,
    date: `${p(local.getUTCDate())}.${p(local.getUTCMonth() + 1)}`,
  };
}

/** Опоздание, о котором стоит сказать: задержка, отмена или позже расписания на 15 минут и больше. */
export function isDisrupted(f: BoardFlight): boolean {
  return f.statusKind !== 'other' || (f.lateMinutes ?? 0) >= 15;
}
