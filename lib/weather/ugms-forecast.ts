/**
 * Прогноз Камчатского УГМС — официальный суточный прогноз по краю, который
 * пишут местные синоптики (владелец 29.10: «по погоде мне нужен самый точный
 * прогноз», «есть же камчатский гидромет»).
 *
 * Источник — kammeteo.ru (ФГБУ «Камчатское УГМС»), две страницы без ключа
 * (проба 1015 с раннера, 29.10): `prognoz/prognozy1.php` — «Прогноз на
 * <дата>» тремя блоками (Петропавловск-Камчатский, южные районы, северные
 * районы), `prognoz/prognozy2.php` — на 2–3 сутки, те же блоки без города,
 * внутри блока абзац на каждый день и заметки («На дорогах гололедица»).
 * Разметка — HTML, текст в абзацах; RSS у сайта нет.
 *
 * Что это даёт туристу: прогноз словами от тех, кто знает местные эффекты
 * (бора на побережье, инверсии в долине, снег в горах при дожде внизу), рядом
 * с числами модели. Текст показывается ДОСЛОВНО с подписью источника и датой,
 * ни во что не пересчитывается и с моделью не смешивается.
 *
 * Чего здесь нет (§4.0): граница «южных» и «северных» районов у УГМС на
 * странице не названа. Юг упоминает «центральные районы» (долина Камчатки),
 * север — Тигильский округ и крайний север. Поэтому место южнее 56° — юг,
 * севернее 57,5° — север, а между ними (Ключи, Усть-Камчатск) показываются
 * ОБА блока с пометкой: угадать за синоптиков нельзя. Город — только сама
 * точка города (15 км от центра): прогноз «Петропавловск-Камчатский» написан
 * для города, не для Авачинского.
 *
 * Год у даты на странице не напечатан: берётся от дня чтения по Камчатке,
 * январь при чтении в декабре — следующий год.
 */
import { createHash } from 'node:crypto';
import { pool } from '@/lib/db-pool';
import { htmlToText } from '@/lib/html/text';
import { decodeHtmlEntities } from '@/lib/html/entities';

export const UGMS_BASE = 'https://kammeteo.ru';
export const UGMS_DAY1_URL = `${UGMS_BASE}/prognoz/prognozy1.php`;
export const UGMS_DAY23_URL = `${UGMS_BASE}/prognoz/prognozy2.php`;
export const UGMS_SOURCE_LABEL = 'ФГБУ «Камчатское УГМС»';
const UA = 'VedarBot/1.0 (+https://vedarai.ru)';
const TIMEOUT_MS = 10_000;

export type UgmsZone = 'city' | 'south' | 'north';
export type UgmsKind = 'day1' | 'day23';

export const UGMS_ZONE_LABELS: Record<UgmsZone, string> = {
  city: 'Петропавловск-Камчатский',
  south: 'южные районы края',
  north: 'северные районы края',
};

export interface UgmsBlock {
  kind: UgmsKind;
  /** День, для которого написан прогноз, YYYY-MM-DD. */
  date: string;
  zone: UgmsZone;
  text: string;
  /** Заметки блока, относящиеся ко всем его дням («На дорогах гололедица»). */
  notes: string[];
}

const MONTHS_RU: Record<string, number> = {
  января: 1, февраля: 2, марта: 3, апреля: 4, мая: 5, июня: 6,
  июля: 7, августа: 8, сентября: 9, октября: 10, ноября: 11, декабря: 12,
};

/** «30 октября» → YYYY-MM-DD; год — от дня чтения, декабрь→январь переходит через год. */
export function ugmsDate(dayMonth: string, readDate: string): string | null {
  const m = /^(\d{1,2})\s+([а-яё]+)$/i.exec(dayMonth.trim());
  if (!m) return null;
  const month = MONTHS_RU[m[2].toLowerCase()];
  const day = Number(m[1]);
  if (!month || day < 1 || day > 31) return null;
  const readY = Number(readDate.slice(0, 4));
  const readM = Number(readDate.slice(5, 7));
  const year = month < readM - 6 ? readY + 1 : month > readM + 6 ? readY - 1 : readY;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCMonth() !== month - 1) return null;
  return d.toISOString().slice(0, 10);
}

function zoneOfHeading(line: string): UgmsZone | null {
  const t = line.trim().toUpperCase();
  if (/^ПЕТРОПАВЛОВСК[- ]КАМЧАТСКИЙ$/.test(t)) return 'city';
  if (/^ЮЖНЫЕ РАЙОНЫ/.test(t)) return 'south';
  if (/^СЕВЕРНЫЕ РАЙОНЫ/.test(t)) return 'north';
  return null;
}

/** HTML страницы → строки текста без разметки и пустых строк. */
export function ugmsLines(html: string): string[] {
  const withBreaks = html.replace(/<br\s*\/?>|<\/(p|div|td|tr|li|h[1-6])\s*>/gi, '\n');
  return decodeHtmlEntities(htmlToText(withBreaks))
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .filter(Boolean);
}

export interface UgmsParse {
  blocks: UgmsBlock[];
  /** Заголовок «ПРОГНОЗ НА …» как на странице; null — не найден. */
  heading: string | null;
  problems: string[];
}

/**
 * Разбор страницы прогноза. `kind` решает форму: у суточного весь текст
 * блока — один день из заголовка; у 2–3-суточного внутри блока абзацы
 * начинаются с даты, прочие строки — заметки блока.
 */
export function parseUgmsPage(html: string, kind: UgmsKind, readDate: string): UgmsParse {
  const lines = ugmsLines(html);
  const headIdx = lines.findIndex((l) => /^ПРОГНОЗ НА /i.test(l));
  if (headIdx < 0) return { blocks: [], heading: null, problems: ['заголовок «ПРОГНОЗ НА …» не найден'] };
  const heading = lines[headIdx];
  const problems: string[] = [];
  const dateTokens = heading.replace(/^ПРОГНОЗ НА /i, '').split(/\s*[-–—]\s*/).map((s) => s.trim());
  const dates = dateTokens.map((t) => ugmsDate(t, readDate));
  if (dates.some((d) => !d)) problems.push(`дата в заголовке не разобрана: «${heading}»`);

  type Raw = { zone: UgmsZone; lines: string[] };
  const raws: Raw[] = [];
  for (const line of lines.slice(headIdx + 1)) {
    const zone = zoneOfHeading(line);
    if (zone) { raws.push({ zone, lines: [] }); continue; }
    if (raws.length === 0) continue;
    // Конец прогноза — подвал сайта: строки, похожие на навигацию или контакты.
    if (/^(на главную|наши координаты|факс|тел\.|e-mail)/i.test(line)) break;
    raws[raws.length - 1].lines.push(line);
  }
  if (raws.length === 0) problems.push('ни одного блока районов после заголовка');

  const blocks: UgmsBlock[] = [];
  for (const raw of raws) {
    if (kind === 'day1') {
      const date = dates[0];
      const text = raw.lines.join(' ').trim();
      if (!date || !text) { problems.push(`блок ${raw.zone} без даты или текста`); continue; }
      blocks.push({ kind, date, zone: raw.zone, text, notes: [] });
      continue;
    }
    const days: Array<{ date: string; text: string }> = [];
    const notes: string[] = [];
    for (const line of raw.lines) {
      const m = /^(\d{1,2}\s+[а-яё]+)\s+(.+)$/i.exec(line);
      const date = m ? ugmsDate(m[1], readDate) : null;
      if (m && date) days.push({ date, text: m[2].trim() });
      else if (days.length > 0 || notes.length > 0 || !m) notes.push(line);
    }
    if (days.length === 0) { problems.push(`блок ${raw.zone}: ни одного дня с датой`); continue; }
    for (const d of days) blocks.push({ kind, date: d.date, zone: raw.zone, text: d.text, notes });
  }
  return { blocks, heading, problems };
}

/**
 * Район прогноза для точки. `city` — только сама точка города; между 56° и
 * 57,5° — граница УГМС не названа, оба блока.
 */
export function ugmsZonesForPoint(lat: number, lng: number): UgmsZone[] {
  const CITY = { lat: 53.02, lng: 158.65 };
  const dLat = (lat - CITY.lat) * 111;
  const dLng = (lng - CITY.lng) * 111 * Math.cos((CITY.lat * Math.PI) / 180);
  if (Math.sqrt(dLat * dLat + dLng * dLng) <= 15) return ['city'];
  if (lat >= 57.5) return ['north'];
  if (lat < 56.0) return ['south'];
  return ['south', 'north'];
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export interface UgmsSync {
  ok: boolean;
  /** Блоков записано (вставлено или обновлено). */
  written: number;
  /** Страниц, которые дошли и разобрались. */
  pagesRead: number;
  problems: string[];
}

// Параметр назван `fetch` намеренно: перепись возможностей кронов
// (lib/agents/cron-capabilities) узнаёт выход в сеть по вызову `fetch(`.
async function fetchPage(url: string, fetch: typeof globalThis.fetch): Promise<{ ok: true; html: string } | { ok: false; reason: string }> {
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status} ${url}` };
    return { ok: true, html: await res.text() };
  } catch (err: unknown) {
    return { ok: false, reason: `${err instanceof Error ? err.message : String(err)} ${url}` };
  }
}

/** Сегодня по Камчатке, YYYY-MM-DD. */
export function kamchatkaToday(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kamchatka', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/**
 * Прочитать обе страницы и записать блоки. Страница, которая не дошла или
 * не разобралась, названа в `problems`; ноль записанных при обеих страницах
 * — отказ (`ok: false`), а не «прогноза нет».
 */
export async function syncUgmsForecast(fetchImpl: typeof fetch = fetch, now: Date = new Date()): Promise<UgmsSync> {
  const readDate = kamchatkaToday(now);
  const problems: string[] = [];
  const blocks: UgmsBlock[] = [];
  let pagesRead = 0;
  for (const [kind, url] of [['day1', UGMS_DAY1_URL], ['day23', UGMS_DAY23_URL]] as Array<[UgmsKind, string]>) {
    const page = await fetchPage(url, fetchImpl);
    if (!page.ok) { problems.push(page.reason); continue; }
    const parsed = parseUgmsPage(page.html, kind, readDate);
    problems.push(...parsed.problems.map((p) => `${kind}: ${p}`));
    if (parsed.blocks.length > 0) pagesRead++;
    blocks.push(...parsed.blocks);
  }
  let written = 0;
  for (const b of blocks) {
    const url = b.kind === 'day1' ? UGMS_DAY1_URL : UGMS_DAY23_URL;
    await pool.query(
      `INSERT INTO ugms_forecasts (kind, forecast_date, zone, text, notes, source_url, text_hash, fetched_at, updated_at)
       VALUES ($1, $2::date, $3, $4, $5::text[], $6, $7, NOW(), NOW())
       ON CONFLICT (kind, forecast_date, zone) DO UPDATE SET
         text = EXCLUDED.text,
         notes = EXCLUDED.notes,
         source_url = EXCLUDED.source_url,
         fetched_at = NOW(),
         updated_at = CASE WHEN ugms_forecasts.text_hash IS DISTINCT FROM EXCLUDED.text_hash THEN NOW() ELSE ugms_forecasts.updated_at END,
         text_hash = EXCLUDED.text_hash`,
      [b.kind, b.date, b.zone, b.text, b.notes, url, sha(`${b.text}\n${b.notes.join('\n')}`)],
    );
    written++;
  }
  return { ok: written > 0, written, pagesRead, problems };
}

export interface UgmsItem {
  date: string;
  zone: UgmsZone;
  text: string;
  notes: string[];
  /** Когда прочитано у УГМС, ISO. */
  fetchedAt: string | null;
  kind: UgmsKind;
}

export type UgmsRead =
  | { kind: 'ok'; zones: UgmsZone[]; items: UgmsItem[]; /** Граница районов не названа — показаны оба. */ ambiguous: boolean }
  | { kind: 'failed'; reason: string };

/**
 * Прогноз УГМС для точки на сегодня и два дня вперёд по Камчатке. На один
 * день и район — одна запись, суточная страница в приоритете над 2–3-суточной.
 * Пусто — «прогноза на эти дни у нас нет», не «погоды нет»; отказ базы — failed.
 */
export async function loadUgmsForecast(lat: number, lng: number, now: Date = new Date()): Promise<UgmsRead> {
  const zones = ugmsZonesForPoint(lat, lng);
  try {
    const { rows } = await pool.query<{
      kind: UgmsKind; date: string; zone: UgmsZone; text: string; notes: string[] | null; fetched_at: string | null;
    }>(
      `SELECT kind, forecast_date::text AS date, zone, text, notes,
              to_char(fetched_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS fetched_at
         FROM ugms_forecasts
        WHERE zone = ANY($1::text[])
          AND forecast_date BETWEEN ($2::date) AND ($2::date + 2)
        ORDER BY forecast_date, zone, CASE kind WHEN 'day1' THEN 0 ELSE 1 END`,
      [zones, kamchatkaToday(now)],
    );
    const seen = new Set<string>();
    const items: UgmsItem[] = [];
    for (const r of rows) {
      const key = `${r.date}/${r.zone}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ date: r.date, zone: r.zone, text: r.text, notes: r.notes ?? [], fetchedAt: r.fetched_at, kind: r.kind });
    }
    return { kind: 'ok', zones, items, ambiguous: zones.length > 1 };
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    console.error('[ugms-forecast] прогноз УГМС не прочитан:', typeof code === 'string' ? code : '', err instanceof Error ? err.message : String(err));
    return { kind: 'failed', reason: 'прогноз УГМС не прочитан из базы' };
  }
}

/** «30.10» из YYYY-MM-DD. */
export function ugmsDayLabel(date: string): string {
  return `${date.slice(8, 10)}.${date.slice(5, 7)}`;
}

/**
 * Строки для Кузьмича: прогноз УГМС рядом с моделью, дословно и с подписью.
 * Пусто — одна строка о том, что прогноза УГМС на эти дни нет (это не «погоды нет»).
 */
export function ugmsLinesForKuzmich(read: UgmsRead): string[] {
  if (read.kind === 'failed') return [`Прогноз Камчатского УГМС: ${read.reason} — не выдумывай его.`];
  if (read.items.length === 0) return ['Прогноза Камчатского УГМС на ближайшие дни у нас сейчас нет (не прочитан) — это не значит, что погода спокойная.'];
  const head = read.ambiguous
    ? 'Прогноз Камчатского УГМС (граница южных и северных районов в прогнозе не названа — даны оба; называй источник и район):'
    : 'Прогноз Камчатского УГМС, дословно (называй источник; это прогноз синоптиков, а не модели):';
  return [head, ...read.items.map((i) => {
    const notes = i.notes.length ? ` ${i.notes.join('. ')}.` : '';
    return `- ${ugmsDayLabel(i.date)}, ${UGMS_ZONE_LABELS[i.zone]}: ${i.text}${notes}`;
  })];
}
