/**
 * Снимок «MCP против сайта» — фиксированный набор для регрессии (29.09).
 *
 * Повод: сверка каналов владельцем нашла три расхождения — единица цены
 * (`р/чел` в MCP против `/группа` на сайте), счётчик обстановки (13 против 5
 * против 15 против 16) и вулканы (8 против 4, Чикурачки латиницей). Каждое
 * нашли глазами, по живым страницам, и каждое можно было бы поймать
 * машиной — если бы один и тот же вопрос задавался обеим сторонам одним и
 * тем же набором, в один момент.
 *
 * Этот модуль — чистая часть: разбор ТЕКСТОВ, которые MCP отдаёт агенту, в
 * поля, и сравнение двух сторон. Ни сети, ни БД. Сбор — `channel-parity-collect`.
 *
 * ── Почему разбираем текст, а не берём данные из тех же функций ────────────
 *
 * Сравнивать данные MCP с данными сайта, взятые у MCP из внутренней
 * структуры, значило бы проверить, что база равна базе. Расхождение 29.09
 * жило в ТЕКСТЕ: цифра была верной, а единица — вшитой строкой в формате.
 * Регрессию ловит только то, что агент реально прочёл.
 *
 * ── Третье состояние (§4.0) ────────────────────────────────────────────────
 *
 * Поле, которого нет в тексте, — `null`, а не 0, не `false` и не пустая
 * строка. `null` с любой стороны означает «не сравнивалось»: расхождением он
 * не считается и подсчитывается отдельно (`not_compared`), чтобы «нечем
 * сверить» не выдавалось за «совпало». Разбор, который не смог ничего
 * извлечь из непустого ответа, — отказ (`failed`), а не пустой снимок.
 */
import { PRICE_UNIT_SHORT } from '@/lib/tours/labels';

// ── Общее ───────────────────────────────────────────────────────────────────

const RU_MONTHS: Record<string, number> = {
  января: 1, февраля: 2, марта: 3, апреля: 4, мая: 5, июня: 6,
  июля: 7, августа: 8, сентября: 9, октября: 10, ноября: 11, декабря: 12,
};

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * «29 сентября» → ГГГГ-ММ-ДД. Год в тексте MCP не называется; берётся тот,
 * при котором дата не раньше `today` — MCP отдаёт ближайшую дату от сегодня,
 * так что прошлого там быть не может. `null` — месяц не узнан или дата не
 * существует.
 */
export function parseRuDayMonth(day: string, month: string, today: string): string | null {
  const m = RU_MONTHS[month.toLowerCase()];
  const d = Number(day);
  if (!m || !Number.isInteger(d) || d < 1 || d > 31) return null;
  const y0 = Number(today.slice(0, 4));
  if (!Number.isInteger(y0)) return null;
  for (const y of [y0, y0 + 1]) {
    const iso = `${y}-${pad(m)}-${pad(d)}`;
    const back = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(back.getTime()) || back.getUTCDate() !== d) continue;
    if (iso >= today) return iso;
  }
  return null;
}

/** «24.09.2026» → «2026-09-24»; иное — null. */
export function ruDateToIso(s: string): string | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s.trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

// ── Туры ────────────────────────────────────────────────────────────────────

export interface TourFacts {
  id: number;
  title: string | null;
  price_amount: number | null;
  /** Код единицы (`per_person` / `per_tour` / `per_day_per_person`); null — не записана или не названа. */
  price_unit: string | null;
  duration_days: number | null;
  operator: string | null;
  activity_type: string | null;
  seats_free: number | null;
  next_date: string | null;
  season_open: boolean | null;
}

export const TOUR_FIELDS = [
  'title', 'price_amount', 'price_unit', 'duration_days', 'operator',
  'activity_type', 'seats_free', 'next_date', 'season_open',
] as const;
export type TourField = (typeof TOUR_FIELDS)[number];

export function emptyTour(id: number): TourFacts {
  return {
    id, title: null, price_amount: null, price_unit: null, duration_days: null,
    operator: null, activity_type: null, seats_free: null, next_date: null, season_open: null,
  };
}

/** Обратная карта подписей: `/группа` → `per_tour`. Словарь один — `PRICE_UNIT_SHORT`. */
function unitFromShort(short: string): string | null {
  for (const [code, label] of Object.entries(PRICE_UNIT_SHORT)) if (label === short) return code;
  return null;
}

// Единицу искать от самой длинной подписи к короткой: «/чел. в день» раньше «/чел.».
const UNIT_ALTERNATION = Object.values(PRICE_UNIT_SHORT)
  .sort((a, b) => b.length - a.length)
  .map((s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'))
  .join('|');
const PRICE_RE = new RegExp(`от\\s+([\\d\\s\\u00a0\\u202f]+?)\\s*₽(${UNIT_ALTERNATION})?`);

/**
 * Каталог туров `get_tours` → факты по id. Строка каталога:
 * `ID27: "Название" — место  тип:x  3 дн. от 13 000 ₽/чел. | Оп: Имя | Мест: 4 | Ближайшая дата: 29 сентября — кратко`.
 * Чего в строке нет, того нет и в результате.
 */
export function parseToursText(text: string, today: string): Map<number, TourFacts> {
  const out = new Map<number, TourFacts>();
  for (const line of text.split('\n')) {
    const idm = /^ID(\d+):\s+"/.exec(line);
    if (!idm) continue;
    const t = emptyTour(Number(idm[1]));
    const parts = line.split(' | ');
    const head = parts[0];

    const q = head.lastIndexOf('"');
    if (q > idm[0].length - 1) t.title = head.slice(idm[0].length, q);
    const rest = q > 0 ? head.slice(q + 1) : head;

    const type = /тип:(\S+)/.exec(rest);
    if (type) t.activity_type = type[1];
    const dur = /(\d+)\s+дн\./.exec(rest);
    if (dur) t.duration_days = Number(dur[1]);
    const price = PRICE_RE.exec(rest);
    if (price) {
      const n = Number(price[1].replace(/[\s  ]/g, ''));
      if (Number.isFinite(n) && n > 0) t.price_amount = n;
      // Цифра без единицы (или с пометкой «за что назначена — не записано»)
      // — единица неизвестна, а не «за человека».
      t.price_unit = price[2] ? unitFromShort(price[2]) : null;
    }

    for (const seg of parts.slice(1)) {
      const op = /^Оп:\s*(.+)$/.exec(seg);
      if (op) { t.operator = op[1].trim(); continue; }
      const seats = /^Мест:\s*(\d+|нет свободных)/.exec(seg);
      if (seats) { t.seats_free = seats[1] === 'нет свободных' ? 0 : Number(seats[1]); continue; }
      const next = /^Ближайшая дата:\s*(\d{1,2})\s+([а-яё]+)/i.exec(seg);
      if (next) t.next_date = parseRuDayMonth(next[1], next[2], today);
    }
    out.set(t.id, t);
  }
  return out;
}

/**
 * `get_tour_availability` → ближайшая дата и места на неё.
 * Строки: `- 29.09 (2026-09-29): свободно 4, от 13 000 ₽/чел.`
 * Пустой ответ («свободных мест … нет») — не отказ, а `dates: []`.
 */
export interface AvailabilityFacts {
  tour_id: number | null;
  dates: Array<{ date: string; free: number; price_amount: number | null; price_unit: string | null }>;
  /** Ответ прочитан, но свободных дат в нём нет — сказано словами. */
  none_free: boolean;
}

export function parseAvailabilityText(text: string): AvailabilityFacts | null {
  const idm = /\(ID(\d+)\)/.exec(text);
  const dates: AvailabilityFacts['dates'] = [];
  for (const line of text.split('\n')) {
    const m = /^-\s+\d{2}\.\d{2}\s+\((\d{4}-\d{2}-\d{2})\):\s+свободно\s+(\d+)(?:,\s*(.+))?$/.exec(line.trim());
    if (!m) continue;
    const p = m[3] ? PRICE_RE.exec(m[3]) : null;
    const amount = p ? Number(p[1].replace(/[\s  ]/g, '')) : NaN;
    dates.push({
      date: m[1],
      free: Number(m[2]),
      price_amount: Number.isFinite(amount) && amount > 0 ? amount : null,
      price_unit: p && p[2] ? unitFromShort(p[2]) : null,
    });
  }
  if (dates.length > 0) return { tour_id: idm ? Number(idm[1]) : null, dates, none_free: false };
  if (/свободных мест.*нет(?![а-яё])/i.test(text)) return { tour_id: idm ? Number(idm[1]) : null, dates: [], none_free: true };
  return null;
}

// ── Обстановка ──────────────────────────────────────────────────────────────

export interface SafetyFacts {
  alert_count: number | null;
  max_severity: number | null;
  top_alert: { text: string | null; source: string | null; kind: string | null } | null;
  updated_at: string | null;
  /** Заголовки списком, как лента `/safety`. У MCP-инструмента списка нет — null. */
  feed_titles: string[] | null;
}

/** `safety_status` → поля. `null` — ответ не разобран (в том числе «данных нет»). */
export function parseSafetyText(text: string): SafetyFacts | null {
  const count = /Активных предупреждений по Камчатскому краю:\s*(\d+)\s*\(максимальная тяжесть\s*(\d+)\s*из\s*5\)/.exec(text);
  const none = /Активных предупреждений по Камчатскому краю нет/.test(text);
  if (!count && !none) return null;
  const top = /^Наиболее значимое:\s*(.*?)(?:\s+\(([a-z_]+)\))?\.\s*$/m.exec(text);
  const src = /^Источник этого предупреждения:\s*(.*?)\.\s*$/m.exec(text);
  const upd = /^Данные обновлены:\s*(.*?)\.\s*$/m.exec(text);
  return {
    alert_count: count ? Number(count[1]) : 0,
    max_severity: count ? Number(count[2]) : 0,
    top_alert: top || src
      ? { text: top ? top[1] : null, source: src ? src[1] : null, kind: top && top[2] ? top[2] : null }
      : null,
    updated_at: upd ? upd[1] : null,
    feed_titles: null,
  };
}

// ── Вулканы ─────────────────────────────────────────────────────────────────

export interface VolcanoFacts {
  name_ru: string | null;
  kvert_color: string | null;
  ash_km: number | null;
  /** Сутки наблюдения KVERT по Камчатке, ГГГГ-ММ-ДД — MCP называет только дату. */
  kvert_observed_at: string | null;
  egs_color: string | null;
  egs_events: number | null;
  egs_bulletin_date: string | null;
}

export const VOLCANO_FIELDS = [
  'name_ru', 'kvert_color', 'ash_km', 'kvert_observed_at', 'egs_color', 'egs_events', 'egs_bulletin_date',
] as const;
export type VolcanoField = (typeof VOLCANO_FIELDS)[number];

export function emptyVolcano(): VolcanoFacts {
  return {
    name_ru: null, kvert_color: null, ash_km: null, kvert_observed_at: null,
    egs_color: null, egs_events: null, egs_bulletin_date: null,
  };
}

const COLOR_BY_WORD: Record<string, string> = {
  зелёный: 'green', зеленый: 'green', жёлтый: 'yellow', желтый: 'yellow',
  оранжевый: 'orange', красный: 'red', 'не присвоен': 'unassigned',
};

export function colorFromWord(w: string): string | null {
  return COLOR_BY_WORD[w.trim().toLowerCase()] ?? null;
}

/** «событий 255» → 255; иначе null. Считает только явное число, не выводит. */
export function eventsFromGist(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /событий\s+(\d+)/i.exec(s);
  return m ? Number(m[1]) : null;
}

/** Часть строки вулкана про КФ ЕГС: `КФ ЕГС (сейсмичность, за 24.09): жёлтый — … событий 255`. */
export function parseEgsPhrase(s: string): { color: string | null; events: number | null; present: boolean } {
  const m = /КФ ЕГС\s*\([^)]*за\s+\d{2}\.\d{2}\):\s*(зел[её]ный|ж[её]лтый|оранжевый|красный)(?:\s*—\s*(.*))?/i.exec(s);
  if (!m) return { color: null, events: null, present: /КФ ЕГС/.test(s) };
  return { color: colorFromWord(m[1]), events: eventsFromGist(m[2]), present: true };
}

/** Часть про KVERT: код, пепел, дата наблюдения. Каждое отсутствующее — null. */
export function parseKvertPhrase(s: string): { color: string | null; ash_km: number | null; observed: string | null } {
  const m = /KVERT \(авиация\):\s*(зел[её]ный|ж[её]лтый|оранжевый|красный|не присвоен)/i.exec(s);
  if (!m) return { color: null, ash_km: null, observed: null };
  const ash = /пепел до\s+([\d.,]+)\s*км/.exec(s);
  const seen = /наблюдение\s+(\d{2}\.\d{2}\.\d{4})/.exec(s);
  const km = ash ? Number(ash[1].replace(',', '.')) : NaN;
  return {
    color: colorFromWord(m[1]),
    ash_km: Number.isFinite(km) ? km : null,
    observed: seen ? ruDateToIso(seen[1]) : null,
  };
}

/** Дата сводки КФ ЕГС из шапки источников: `КФ ЕГС: сводка за 24.09.2026` / `последняя сводка за …`. */
export function parseBulletinDate(text: string): string | null {
  const m = /КФ ЕГС:[^;.]*?сводк[аи]?\s+за\s+(\d{2}\.\d{2}\.\d{4})/.exec(text);
  return m ? ruDateToIso(m[1]) : null;
}

/**
 * Ответ `get_volcano_status` по ОДНОМУ названному вулкану → поля.
 * `null` — вулкана в сводках нет (сказано словами) либо ответ не разобран.
 * Выбирается строка, начинающаяся с имени; без совпадения берётся первая
 * строка вулкана — MCP при запросе по имени отдаёт до пяти совпадений.
 */
export function parseVolcanoText(text: string, pick?: (name: string) => boolean): VolcanoFacts | null {
  if (/нет в сводках KVERT и КФ ЕГС/.test(text)) return null;
  const lines = text.split('\n').filter((l) => /^[^:]+: КФ ЕГС/.test(l));
  if (lines.length === 0) return null;
  const line = (pick ? lines.find((l) => pick(l.slice(0, l.indexOf(':')))) : undefined) ?? lines[0];
  const name = line.slice(0, line.indexOf(':')).trim();
  const kf = parseEgsPhrase(line);
  const kv = parseKvertPhrase(line);
  // Дата — только когда у вулкана есть само чтение КФ ЕГС («КФ ЕГС (… за 24.09)»):
  // «в сводке этого вулкана нет» и «свежей сводки нет» даты не имеют.
  const bulletin = /КФ ЕГС\s*\(/.test(line) ? parseBulletinDate(text) : null;
  return {
    name_ru: name || null,
    kvert_color: kv.color,
    ash_km: kv.ash_km,
    kvert_observed_at: kv.observed,
    egs_color: kf.color,
    egs_events: kf.events,
    egs_bulletin_date: bulletin,
  };
}

/** Число вулканов в шапке общего ответа: «повышенная … — 8:» и «KVERT: 20 вулканов». */
export interface VolcanoAggregates {
  /** Повышенных хотя бы по одной шкале. null — в ответе не названо. */
  elevated_any_scale: number | null;
  /** Сколько вулканов ведёт KVERT. null — не названо. */
  kvert_watched: number | null;
}

export function parseVolcanoAggregates(text: string): VolcanoAggregates {
  const el = /Повышенная активность хотя бы по одной шкале — (\d+):/.exec(text);
  const none = /Повышенной активности нет ни по одной шкале/.test(text);
  const w = /KVERT:\s*(\d+)\s+вулканов/.exec(text);
  return {
    elevated_any_scale: el ? Number(el[1]) : none ? 0 : null,
    kvert_watched: w ? Number(w[1]) : null,
  };
}

// ── Контракт ────────────────────────────────────────────────────────────────

export interface ContractParam { name: string; type: string | null; required: boolean }
export interface ContractTool { name: string; params: ContractParam[] }

/** Схема инструмента → параметры в порядке объявления. Формы, которой не ждали, — пустой список, а не догадка. */
export function contractParams(inputSchema: unknown): ContractParam[] {
  if (!inputSchema || typeof inputSchema !== 'object') return [];
  const s = inputSchema as { properties?: unknown; required?: unknown };
  const req = new Set(Array.isArray(s.required) ? s.required.filter((x): x is string => typeof x === 'string') : []);
  if (!s.properties || typeof s.properties !== 'object') return [];
  return Object.entries(s.properties as Record<string, unknown>).map(([name, def]) => {
    const t = def && typeof def === 'object' ? (def as { type?: unknown }).type : undefined;
    return { name, type: typeof t === 'string' ? t : Array.isArray(t) ? t.join('|') : null, required: req.has(name) };
  });
}

// ── Сравнение ───────────────────────────────────────────────────────────────

export interface Diff {
  scope: string;
  field: string;
  mcp: unknown;
  ui: unknown;
}

export interface NotCompared {
  scope: string;
  field: string;
  /** Какая сторона молчит: `mcp`, `ui` или обе. */
  silent: Array<'mcp' | 'ui'>;
}

function same(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  return a === b;
}

/**
 * Сравнить два набора полей. Поле, у которого хотя бы одна сторона `null`,
 * расхождением не считается — оно уходит в `not_compared` с указанием,
 * кто молчит. Иначе «MCP не сообщает» читалось бы как «MCP ошибся».
 */
export function diffFields(
  scope: string,
  fields: readonly string[],
  mcp: Record<string, unknown> | null,
  ui: Record<string, unknown> | null,
): { diffs: Diff[]; not_compared: NotCompared[] } {
  const diffs: Diff[] = [];
  const not_compared: NotCompared[] = [];
  for (const f of fields) {
    const a = mcp ? (mcp[f] ?? null) : null;
    const b = ui ? (ui[f] ?? null) : null;
    if (a === null || b === null) {
      const silent: Array<'mcp' | 'ui'> = [];
      if (a === null) silent.push('mcp');
      if (b === null) silent.push('ui');
      not_compared.push({ scope, field: f, silent });
    } else if (!same(a, b)) {
      diffs.push({ scope, field: f, mcp: a, ui: b });
    }
  }
  return { diffs, not_compared };
}
