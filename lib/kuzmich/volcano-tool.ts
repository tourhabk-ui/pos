/**
 * Вулканы края по двум шкалам — свой инструмент `get_volcano_status` (25.09).
 *
 * До этого дня вулканическую обстановку снаружи можно было узнать только
 * косвенно: `get_guardian_context` отвечал про ОДНО названное место, а
 * `safety_status` — про тревоги вообще. Вопрос «какие вулканы сейчас
 * активны» задать было нечем, хотя обе сводки у платформы есть:
 *
 *  - KVERT — авиационный цветовой код (пепел для самолётов), таблица
 *    `volcano_status`, синк раз в 6 часов (`lib/agents/kvert-sync`);
 *  - КФ ЕГС РАН — дневная сводка сейсмичности вулканов, таблица
 *    `volcano_bulletin_kfegs` (`lib/services/safety/emsd-vmon-sync`).
 *
 * Шкалы разные, победителя нет (случай 22.09: Мутновский и Горелый жёлтые по
 * КФ ЕГС при зелёном KVERT). Поэтому вулкан повышен, если повышен хотя бы по
 * одной, и в ответе стоят обе — тем же правилом и теми же фразами, что
 * радар главной (`volcano-scales`) и контекст места (`guardian-context`).
 *
 * Исходы (§4.0): источник не прочитан, сводка устарела и «повышенных нет»
 * — разные ответы. «Все спокойны» говорится только когда обе шкалы свежие.
 */
import { pool } from '@/lib/db-pool';
import { ACC_META, isVolcanoObservationStale, VOLCANO_STALE_DAYS, type AccColor } from '@/lib/services/safety/kvert-vona';
import { kfegsIsFresh, kfegsPhrase, type KfegsReading, type ScaleColor } from '@/lib/services/safety/volcano-scales';
import { volcanoStem } from '@/lib/services/safety/volcano-match';
import { normalizeVolcanoName } from '@/lib/services/safety/kvert-vona';

export interface KvertRow {
  ark: string | null;
  place_name: string | null;
  name: string;
  acc: string;
  ash_height_m: number | null;
  observed_at: string | null;
  /**
   * Когда НАШ синк последний раз записал строку (`volcano_status.updated_at`).
   * `observed_at` — дата выпуска KVERT, а KVERT выпускает код при изменении:
   * код от 02.10 при опросе этого утра — текущий, а не устаревший (#2315).
   * Без этого поля агент не мог отличить «KVERT молчит» от «мы не опрашиваем».
   */
  polled_at?: string | null;
}

export interface KfegsRow {
  ark: string | null;
  place_name: string | null;
  name: string;
  name_en: string | null;
  color: ScaleColor | null;
  raw: string;
  seismicity: string | null;
}

export interface VolcanoInput {
  /** null — таблицу прочитать не смогли. */
  kvert: KvertRow[] | null;
  /** Дата последней сводки КФ ЕГС; null — сводок нет или не прочитали. */
  kfegsDate: string | null;
  /** null — сводку прочитать не смогли. */
  kfegs: KfegsRow[] | null;
}

export interface MergedVolcano {
  name: string;
  aliases: string[];
  kvert: KvertRow | null;
  kfegs: KfegsReading | null;
}

const ELEVATED = new Set(['yellow', 'orange', 'red']);
const LIST_LIMIT = 15;
/**
 * Наш опрос KVERT встал: синк каждые 6 часов (cron-kvert-acc.yml), и три
 * пропущенных прогона подряд — уже не случайность расписания GitHub.
 */
export const KVERT_POLL_STALE_MS = 18 * 3600_000;

function accColor(acc: string): AccColor {
  return acc === 'green' || acc === 'yellow' || acc === 'orange' || acc === 'red' ? acc : 'unassigned';
}

function ruDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('ru-RU', { timeZone: 'Asia/Kamchatka' });
}

/** ДД.ММ ЧЧ:ММ по Камчатке — момент опроса, а не сутки. */
function ruStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('ru-RU', {
    timeZone: 'Asia/Kamchatka', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  }).replace(',', '');
}

/** Строка KVERT: код, пепел, когда наблюдали — и честно, если наблюдение старое. */
export function kvertPhrase(k: KvertRow | null, nowMs: number = Date.now()): string {
  if (!k) return 'KVERT (авиация): кода нет';
  const meta = ACC_META[accColor(k.acc)];
  const ash = k.ash_height_m ? `, пепел до ${(k.ash_height_m / 1000).toFixed(1)} км` : '';
  const seen = k.observed_at ? `, наблюдение ${ruDate(k.observed_at)}` : '';
  const stale = isVolcanoObservationStale(k.observed_at, nowMs)
    ? ` — наблюдение старше ${VOLCANO_STALE_DAYS} дней, текущим его не считать`
    : '';
  return `KVERT (авиация): ${meta.short.toLowerCase()} — ${meta.label.toLowerCase()}${ash}${seen}${stale}`;
}

/**
 * Свести обе шкалы по вулкану. Ключ — место каталога (`place_ark_id`), без
 * него — имя: английское у KVERT и у КФ ЕГС совпадает по источнику чаще,
 * чем русское с каталогом.
 */
export function mergeVolcanoes(input: VolcanoInput, nowMs: number = Date.now()): MergedVolcano[] {
  const byKey = new Map<string, MergedVolcano>();
  const fresh = input.kfegsDate !== null && kfegsIsFresh(input.kfegsDate, nowMs);
  const keyOf = (ark: string | null, name: string) => (ark ? `ark:${ark}` : `name:${name.trim().toLowerCase()}`);

  for (const k of input.kvert ?? []) {
    const key = keyOf(k.ark, k.name);
    // Имя места, а если места в каталоге нет — русское имя из общего словаря
    // (KVERT присылает латиницей и капсом: `CHIKURACHKI`). 29.09 сверка
    // каналов: Чикурачки, оранжевый по KVERT, отдавался агенту латиницей,
    // хотя словарь его знает. Незнакомое остаётся как есть: «похожее» не
    // подставляем. Латинское имя остаётся среди алиасов — поиск по нему жив.
    const shown = k.place_name ?? normalizeVolcanoName(k.name)?.ru ?? k.name;
    byKey.set(key, { name: shown, aliases: [k.name], kvert: k, kfegs: null });
  }
  if (fresh && input.kfegsDate) {
    for (const b of input.kfegs ?? []) {
      const key = b.ark ? keyOf(b.ark, b.name) : keyOf(null, b.name_en ?? b.name);
      const reading: KfegsReading = { color: b.color, raw: b.raw, seismicity: b.seismicity, date: input.kfegsDate };
      const cur = byKey.get(key);
      if (cur) {
        cur.kfegs = reading;
        cur.aliases.push(b.name, ...(b.name_en ? [b.name_en] : []));
        if (!b.place_name && !cur.kvert?.place_name) cur.name = b.name;
      } else {
        byKey.set(key, {
          name: b.place_name ?? b.name,
          aliases: [b.name, ...(b.name_en ? [b.name_en] : [])],
          kvert: null,
          kfegs: reading,
        });
      }
    }
  }
  return [...byKey.values()];
}

function isElevated(m: MergedVolcano): boolean {
  return (m.kvert !== null && ELEVATED.has(m.kvert.acc)) || (m.kfegs?.color != null && ELEVATED.has(m.kfegs.color));
}

function rank(m: MergedVolcano): number {
  const r = (c: string | null | undefined) => (c === 'red' ? 3 : c === 'orange' ? 2 : c === 'yellow' ? 1 : 0);
  return Math.max(r(m.kvert?.acc), r(m.kfegs?.color));
}

/**
 * Строка вулкана. Нет строки КФ ЕГС при СВЕЖЕЙ сводке — вулкан ею не охвачен
 * (курильские, северные), а не «сводки нет»: первая приёмка 25.09 писала
 * про Чикурачки «свежей сводки нет» при сводке того же утра.
 */
function volcanoLine(m: MergedVolcano, nowMs: number, bulletinFresh: boolean): string {
  const kf = !m.kfegs && bulletinFresh ? 'КФ ЕГС: в сводке этого вулкана нет' : kfegsPhrase(m.kfegs);
  return `${m.name}: ${kf} · ${kvertPhrase(m.kvert, nowMs)}`;
}

/** Дата сводки ДД.ММ.ГГГГ из YYYY-MM-DD — без часовых поясов: это сутки, а не момент. */
function bulletinDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

function matches(m: MergedVolcano, query: string): boolean {
  const q = query.trim().toLowerCase();
  const qs = volcanoStem(query);
  return [m.name, ...m.aliases].some((n) => {
    const low = n.toLowerCase();
    if (low.includes(q)) return true;
    const s = volcanoStem(n);
    return qs.length > 0 && s.length > 0 && (s === qs || s.startsWith(qs) || qs.startsWith(s));
  });
}

/** Состояние источников — первой строкой, чтобы «повышенных нет» читалось в своём контексте. */
function sourcesLine(input: VolcanoInput, nowMs: number): { text: string; complete: boolean } {
  const parts: string[] = [];
  let complete = true;
  if (input.kvert === null) {
    parts.push('KVERT: не смог прочитать');
    complete = false;
  } else {
    const latest = input.kvert.map((k) => k.observed_at).filter((x): x is string => !!x).sort().pop() ?? null;
    // Момент нашего опроса — по самой свежей записи: вулкан, которого KVERT
    // больше не перечисляет, держит старый момент, и судить по нему нельзя.
    const polled = input.kvert.map((k) => k.polled_at).filter((x): x is string => !!x)
      .sort((a, b) => Date.parse(a) - Date.parse(b)).pop() ?? null;
    const polledMs = polled ? Date.parse(polled) : NaN;
    const pollStale = Number.isFinite(polledMs) && nowMs - polledMs > KVERT_POLL_STALE_MS;
    const poll = !polled ? ''
      : pollStale ? `; наш опрос KVERT встал — последний ${ruStamp(polled)} по Камчатке, коды могут быть не текущими`
      : `; опрошен нами ${ruStamp(polled)} по Камчатке`;
    if (pollStale) complete = false;
    if (input.kvert.length === 0 || !latest) { parts.push(`KVERT: кодов нет${poll}`); complete = false; }
    else if (isVolcanoObservationStale(latest, nowMs)) { parts.push(`KVERT: последнее наблюдение ${ruDate(latest)} — устарело${poll}`); complete = false; }
    else {
      parts.push(
        `KVERT: ${input.kvert.length} вулканов, самое свежее наблюдение ${ruDate(latest)} (у каждого вулкана своя дата — в его строке; `
        + `KVERT выпускает код при изменении, старая дата при свежем опросе — код всё ещё в силе)${poll}`,
      );
    }
  }
  if (input.kfegs === null) {
    parts.push('КФ ЕГС: не смог прочитать');
    complete = false;
  } else if (!input.kfegsDate) {
    parts.push('КФ ЕГС: сводок нет');
    complete = false;
  } else if (!kfegsIsFresh(input.kfegsDate, nowMs)) {
    parts.push(`КФ ЕГС: последняя сводка за ${bulletinDate(input.kfegsDate)} — устарела, её цвета не учтены`);
    complete = false;
  } else {
    parts.push(`КФ ЕГС: сводка за ${bulletinDate(input.kfegsDate)}, вулканов ${input.kfegs.length}`);
  }
  return { text: `Источники — ${parts.join('; ')}.`, complete };
}

const FOOTER = 'Цветовые коды — об активности вулкана, а не разрешение на выход: закрытые зоны и регистрация в МЧС — отдельно.';

/** Повышенные хотя бы по одной шкале, опаснейшие первыми — один порядок для Кузьмича и сводки. */
function sortElevated(all: MergedVolcano[]): MergedVolcano[] {
  return all.filter(isElevated).sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name, 'ru'));
}

/**
 * То же, что видит Кузьмич без имени вулкана, но данными, а не текстом: для
 * страницы сводки (`/svodka`). Правило отбора и порядок — одни с
 * `composeVolcanoReport`, иначе сводка и ответ агента разойдутся.
 */
export function elevatedVolcanoes(input: VolcanoInput, nowMs: number = Date.now()): {
  sources: string;
  complete: boolean;
  items: MergedVolcano[];
} {
  const src = sourcesLine(input, nowMs);
  return { sources: src.text, complete: src.complete, items: sortElevated(mergeVolcanoes(input, nowMs)) };
}

/** Ответ инструмента: без имени — повышенные по любой шкале, с именем — этот вулкан по обеим. */
export function composeVolcanoReport(input: VolcanoInput, query: string | undefined, nowMs: number = Date.now()): string {
  const src = sourcesLine(input, nowMs);
  const all = mergeVolcanoes(input, nowMs);
  const fresh = input.kfegs !== null && input.kfegsDate !== null && kfegsIsFresh(input.kfegsDate, nowMs);

  if (query && query.trim()) {
    const found = all.filter((m) => matches(m, query));
    if (found.length === 0) {
      return [
        src.text,
        `Вулкана «${query.trim()}» нет в сводках KVERT и КФ ЕГС. Это НЕ значит, что он спокоен: сводки охватывают не все вулканы. `
          + 'Для безопасности конкретного места есть get_guardian_context.',
      ].join('\n');
    }
    return [src.text, ...found.slice(0, 5).map((m) => volcanoLine(m, nowMs, fresh)), FOOTER].join('\n');
  }

  const elevated = sortElevated(all);
  if (elevated.length === 0) {
    return [
      src.text,
      src.complete
        ? 'Повышенной активности нет ни по одной шкале.'
        : 'По доступным данным повышенных нет, но не все источники проверены (см. выше) — это не «все вулканы спокойны».',
      FOOTER,
    ].join('\n');
  }
  const more = elevated.length > LIST_LIMIT ? `…и ещё ${elevated.length - LIST_LIMIT}.` : null;
  return [
    src.text,
    `Повышенная активность хотя бы по одной шкале — ${elevated.length}:`,
    ...elevated.slice(0, LIST_LIMIT).map((m) => volcanoLine(m, nowMs, fresh)),
    ...(more ? [more] : []),
    ...(src.complete ? [] : ['Не все источники проверены — список может быть неполным.']),
    FOOTER,
  ].join('\n');
}

/**
 * Вулкан, которого нет в справочнике мест, но который есть в сводках
 * (#2134, 30.09): `get_guardian_context("Чикурачки")` отвечал «ни места, ни
 * предупреждений нет», хотя `get_volcano_status` знал его оранжевый код
 * KVERT. Человек читал отсутствие данных как отсутствие опасности.
 *
 * Возвращает строки сводок по этому вулкану или null — вулкана нет и в
 * сводках. Статуса МЕСТА здесь нет и не выдумывается: его считает крон по
 * справочнику, а записи в справочнике нет.
 */
export function volcanoLinesForName(input: VolcanoInput, query: string, nowMs: number = Date.now()): string[] | null {
  if (!query.trim()) return null;
  const found = mergeVolcanoes(input, nowMs).filter((m) => matches(m, query));
  if (found.length === 0) return null;
  const fresh = input.kfegs !== null && input.kfegsDate !== null && kfegsIsFresh(input.kfegsDate, nowMs);
  return [sourcesLine(input, nowMs).text, ...found.slice(0, 3).map((m) => volcanoLine(m, nowMs, fresh)), FOOTER];
}

/** Прочитать обе сводки. Каждый источник — своим try: отказ одного не гасит другой. */
export async function loadVolcanoInput(): Promise<VolcanoInput> {
  let kvert: KvertRow[] | null = null;
  try {
    const { rows } = await pool.query<KvertRow>(
      `SELECT vs.place_ark_id::text AS ark, p.name AS place_name, vs.volcano_name AS name,
              vs.aviation_color_code AS acc, vs.ash_height_m, vs.observed_at::text AS observed_at,
              vs.updated_at::text AS polled_at
         FROM volcano_status vs
         LEFT JOIN places p ON p.ark_id = vs.place_ark_id AND p.merged_into_id IS NULL`,
    );
    kvert = rows;
  } catch (err) {
    console.error('[volcano-tool] volcano_status не прочитан:', err instanceof Error ? err.message : err);
  }

  let kfegsDate: string | null = null;
  let kfegs: KfegsRow[] | null = null;
  try {
    const latest = await pool.query<{ d: string | null }>(`SELECT MAX(observed_date)::text AS d FROM volcano_bulletin_kfegs`);
    kfegsDate = latest.rows[0]?.d ?? null;
    if (kfegsDate) {
      const { rows } = await pool.query<KfegsRow>(
        `SELECT b.place_ark_id::text AS ark, p.name AS place_name, b.volcano_name AS name,
                b.volcano_name_en AS name_en, b.color, b.color_raw AS raw, b.seismicity
           FROM volcano_bulletin_kfegs b
           LEFT JOIN places p ON p.ark_id = b.place_ark_id AND p.merged_into_id IS NULL
          WHERE b.observed_date = $1::date`,
        [kfegsDate],
      );
      kfegs = rows;
    } else {
      kfegs = [];
    }
  } catch (err) {
    console.error('[volcano-tool] volcano_bulletin_kfegs не прочитан:', err instanceof Error ? err.message : err);
    kfegs = null;
  }
  return { kvert, kfegsDate, kfegs };
}

export async function volcanoStatusForKuzmich(args: { volcano?: string }): Promise<string> {
  return composeVolcanoReport(await loadVolcanoInput(), args.volcano);
}
