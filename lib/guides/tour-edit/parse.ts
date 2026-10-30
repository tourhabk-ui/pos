/**
 * Разбор фразы гида о правке своего тура — правилами, без модели (слово
 * владельца 30.10 «гид должен полностью управлять своей ролью из MAX»).
 *
 * Форма одна: `<тур>: <поле>: <текст>`, у цены — `<тур>: цена 16000`.
 * Тур можно не называть («описание: …»): тур один — он, туров несколько —
 * выбор кнопками. Примеры:
 *   Горелый: описание: Восхождение на действующий вулкан…
 *   Горелый: цена 16 000
 *   Горелый: программа:
 *     1. Дорога: выезд в 7:00…
 *     2. Восхождение: 3 часа…
 *   Толбачик: что взять: ботинки, куртка, перчатки
 *
 * Поле — слово из `FIELD_WORDS`, после него — двоеточие (у цены можно
 * пробел). Фраза другой формы — `null`: это не правка, сообщение идёт
 * помощнику как раньше. Правка, которую разобрать нельзя (пусто, длинно,
 * цена не числом), — отказ с причиной: помощник-модель её не получает,
 * иначе сказал бы «сохранил», ничего не сохранив.
 *
 * Пределы — те же, что у формы кабинета оператора (UpdateTourSchema):
 * название 5–255, анонс до 500, описание до 2000, пункт списка до 200, не
 * больше 30 пунктов.
 */

import type { TourProgramStep } from '@/lib/tours/tour-write';

export const EDIT_FIELDS = [
  'title', 'short_description', 'description', 'program', 'included', 'not_included',
  'what_to_bring', 'safety_notes', 'base_price',
] as const;
export type EditField = (typeof EDIT_FIELDS)[number];

export type ListField = 'included' | 'not_included' | 'what_to_bring' | 'safety_notes';
export type TextField = 'title' | 'short_description' | 'description';

export type EditValue = string | string[] | TourProgramStep[] | number;

/** Как поле зовётся в ответе гиду. */
export const FIELD_LABEL: Readonly<Record<EditField, string>> = {
  title: 'Название',
  short_description: 'Анонс',
  description: 'Описание',
  program: 'Программа',
  included: 'Что включено',
  not_included: 'Что не входит',
  what_to_bring: 'Что взять с собой',
  safety_notes: 'Безопасность',
  base_price: 'Цена',
};

/** Слова поля в начале правки. Длинные — первыми: «не входит» раньше «входит». */
const FIELD_WORDS: ReadonlyArray<[string, EditField]> = ([
  ['краткое описание', 'short_description'],
  ['анонс', 'short_description'],
  ['кратко', 'short_description'],
  ['коротко', 'short_description'],
  ['описание', 'description'],
  ['название', 'title'],
  ['программа', 'program'],
  ['не входит в стоимость', 'not_included'],
  ['не входит в цену', 'not_included'],
  ['не включено', 'not_included'],
  ['не входит', 'not_included'],
  ['входит в стоимость', 'included'],
  ['входит в цену', 'included'],
  ['что включено', 'included'],
  ['включено', 'included'],
  ['входит', 'included'],
  ['что взять с собой', 'what_to_bring'],
  ['взять с собой', 'what_to_bring'],
  ['что взять', 'what_to_bring'],
  ['снаряжение', 'what_to_bring'],
  ['правила безопасности', 'safety_notes'],
  ['безопасность', 'safety_notes'],
  ['важно знать', 'safety_notes'],
  ['цена', 'base_price'],
  ['стоимость', 'base_price'],
] as Array<[string, EditField]>).sort((a, b) => b[0].length - a[0].length);

export const LIMITS = {
  titleMin: 5,
  title: 255,
  short_description: 500,
  description: 2000,
  listItem: 200,
  listItems: 30,
  programSteps: 20,
  stepTitle: 200,
  stepText: 3000,
  tourWords: 80,
  priceMin: 100,
  priceMax: 10_000_000,
} as const;

export interface ParsedEdit {
  /** Слова тура до первого двоеточия; null — тур не назван. */
  tourWords: string | null;
  field: EditField;
  value: EditValue;
}

export type EditReject =
  | { reason: 'empty' }
  | { reason: 'too_short'; max: number }
  | { reason: 'too_long'; max: number; got: number }
  | { reason: 'bad_price' }
  | { reason: 'price_range' }
  | { reason: 'too_many'; max: number; got: number }
  | { reason: 'item_too_long'; index: number; max: number }
  | { reason: 'step_no_title'; index: number };

export type EditParse =
  | { ok: true; edit: ParsedEdit }
  | ({ ok: false; field: EditField; tourWords: string | null } & EditReject);

function lower(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е');
}

/** Поле в начале строки и что после него; null — поля нет. */
function fieldAt(rest: string): { field: EditField; after: string } | null {
  const low = lower(rest);
  for (const [word, field] of FIELD_WORDS) {
    if (!low.startsWith(word)) continue;
    const after = rest.slice(word.length);
    // Слово целиком: «описание» не «описания тура…».
    const sep = /^\s*:/.exec(after);
    if (sep) return { field, after: after.slice(sep[0].length) };
    if (field === 'base_price' && /^\s+\d/.test(after)) return { field, after };
    return null;
  }
  return null;
}

/**
 * Правка тура или нет. `null` — не правка (другая форма фразы): сообщение
 * идёт дальше своим путём.
 */
export function parseTourEdit(raw: string): EditParse | null {
  const text = raw.replace(/\r\n?/g, '\n').trim();
  if (!text || text.startsWith('/')) return null;
  let tourWords: string | null = null;
  let hit = fieldAt(text);
  if (!hit) {
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    const head = text.slice(0, colon).trim();
    if (!head || head.length > LIMITS.tourWords || head.includes('\n')) return null;
    hit = fieldAt(text.slice(colon + 1).trimStart());
    if (!hit) return null;
    tourWords = head.replace(/^[«"„]+|[»"“]+$/g, '').trim();
    if (!tourWords) return null;
  }
  const { field } = hit;
  const value = parseValue(field, hit.after);
  if ('reason' in value) return { ok: false, field, tourWords, ...value };
  return { ok: true, edit: { tourWords, field, value: value.value } };
}

function parseValue(field: EditField, after: string): { value: EditValue } | EditReject {
  const body = after.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!body) return { reason: 'empty' };
  switch (field) {
    case 'base_price': return parsePrice(body);
    case 'title': {
      const one = body.replace(/\s+/g, ' ');
      if (one.length < LIMITS.titleMin) return { reason: 'too_short', max: LIMITS.titleMin };
      if (one.length > LIMITS.title) return { reason: 'too_long', max: LIMITS.title, got: one.length };
      return { value: one };
    }
    case 'short_description':
    case 'description': {
      const max = LIMITS[field];
      if (body.length > max) return { reason: 'too_long', max, got: body.length };
      return { value: body };
    }
    case 'program': return parseProgram(body);
    default: return parseList(field, body);
  }
}

/** «16000», «16 000», «16 000 ₽», «16000 руб». Копеек и диапазонов нет. */
export function parsePrice(body: string): { value: number } | EditReject {
  const m = /^(\d{1,3}(?:[   ]\d{3})+|\d+)\s*(?:₽|р\.?|руб\.?|рублей|рубля)?\s*\.?$/i.exec(body.trim());
  if (!m) return { reason: 'bad_price' };
  const n = Number(m[1]!.replace(/[   ]/g, ''));
  if (!Number.isSafeInteger(n)) return { reason: 'bad_price' };
  if (n < LIMITS.priceMin || n > LIMITS.priceMax) return { reason: 'price_range' };
  return { value: n };
}

const BULLET = /^(?:[-–—•*·]\s*|\d{1,2}[.)]\s+)/;
const NUMBERED = /^\d{1,2}[.)]\s+/;

/** Строки значения; одна строка с «1. … 2. …» делится по номерам. */
function lines(body: string): string[] {
  const rows = body.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (rows.length === 1 && NUMBERED.test(rows[0]!)) {
    const parts = rows[0]!.split(/\s+(?=\d{1,2}[.)]\s)/).map((p) => p.trim()).filter(Boolean);
    if (parts.length > 1) return parts;
  }
  return rows;
}

function parseList(field: ListField, body: string): { value: string[] } | EditReject {
  let items = lines(body);
  // Одна строка без номеров: «ботинки; куртка» — по «;», а состав и вещи —
  // и по запятой («ботинки, куртка, перчатки»). Правила безопасности по
  // запятой не делятся: в них запятая — часть фразы. Что вышло, гид видит в
  // предпросмотре до кнопки.
  if (items.length === 1) {
    const one = items[0]!;
    const bySemicolon = one.split(';').map((s) => s.trim()).filter(Boolean);
    if (bySemicolon.length > 1) items = bySemicolon;
    else if (field !== 'safety_notes') {
      const byComma = one.split(',').map((s) => s.trim()).filter(Boolean);
      if (byComma.length > 1) items = byComma;
    }
  }
  const clean = items.map((i) => i.replace(BULLET, '').trim()).filter((i) => i.length > 0);
  if (clean.length === 0) return { reason: 'empty' };
  if (clean.length > LIMITS.listItems) return { reason: 'too_many', max: LIMITS.listItems, got: clean.length };
  const long = clean.findIndex((i) => i.length > LIMITS.listItem);
  if (long >= 0) return { reason: 'item_too_long', index: long + 1, max: LIMITS.listItem };
  return { value: clean };
}

/**
 * Шаги программы. С номерами — шаг начинается строкой с номера, строки без
 * номера дописываются к его тексту; без номеров — шаг на строку. Заголовок
 * шага — до двоеточия или тире; нет их — первое предложение; шаг из одного
 * короткого предложения — один заголовок. Ничего из этого — отказ: заголовок
 * не выдумывается.
 */
export function parseProgram(body: string): { value: TourProgramStep[] } | EditReject {
  const rows = lines(body);
  const numbered = rows.some((r) => NUMBERED.test(r));
  const raw: string[] = [];
  for (const r of rows) {
    if (!numbered || NUMBERED.test(r) || raw.length === 0) raw.push(r.replace(BULLET, '').trim());
    else raw[raw.length - 1] = `${raw[raw.length - 1]}\n${r}`;
  }
  const steps = raw.filter((s) => s.length > 0);
  if (steps.length === 0) return { reason: 'empty' };
  if (steps.length > LIMITS.programSteps) return { reason: 'too_many', max: LIMITS.programSteps, got: steps.length };
  const out: TourProgramStep[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = splitStep(steps[i]!);
    if (!step) return { reason: 'step_no_title', index: i + 1 };
    if (step.title.length > LIMITS.stepTitle) return { reason: 'item_too_long', index: i + 1, max: LIMITS.stepTitle };
    if (step.text.length > LIMITS.stepText) return { reason: 'item_too_long', index: i + 1, max: LIMITS.stepText };
    out.push(step);
  }
  return { value: out };
}

const STEP_TITLE_MAX = 120;

function splitStep(s: string): TourProgramStep | null {
  const firstLine = s.split('\n')[0]!;
  const sep = /\s*(?::|\s[—–-])\s+/.exec(firstLine);
  if (sep && sep.index > 0 && sep.index <= STEP_TITLE_MAX) {
    const title = firstLine.slice(0, sep.index).trim();
    const text = s.slice(sep.index + sep[0].length).trim();
    if (title) return { title, text };
  }
  const dot = /[.!?](?:\s|$)/.exec(firstLine);
  if (dot && dot.index > 0 && dot.index < STEP_TITLE_MAX) {
    const title = firstLine.slice(0, dot.index).trim();
    const text = s.slice(dot.index + 1).trim();
    if (title) return { title, text };
  }
  if (!s.includes('\n') && s.length <= STEP_TITLE_MAX) return { title: s.trim(), text: '' };
  return null;
}

// ── Тур по словам гида ─────────────────────────────────────────────────────

export interface EditTour {
  id: string;
  title: string;
}

export type TourPick =
  | { kind: 'one'; tour: EditTour }
  | { kind: 'choose'; tours: EditTour[] }
  | { kind: 'missing' };

function tokens(s: string): string[] {
  return lower(s).replace(/[«»"„“'().,!?:;]/g, ' ').split(/[\s\-–—]+/).filter((t) => t.length > 0);
}

/** Слово гида похоже на слово названия: числа — равны, слова — общая основа. */
function tokenMatches(q: string, t: string): boolean {
  if (/^\d+$/.test(q) || /^\d+$/.test(t)) return q === t;
  if (q.length < 3) return t === q;
  const stem = Math.min(q.length, t.length, 5);
  if (stem < 3) return false;
  return q.slice(0, stem) === t.slice(0, stem) && Math.min(q.length, t.length) >= Math.min(4, q.length);
}

/**
 * Тур среди своих. Название целиком — он; иначе каждое слово гида должно
 * найтись в названии. Подходят несколько — выбор кнопками, а не догадка.
 * Тур не назван (`null`) — один тур — он, несколько — выбор.
 */
export function pickTour(words: string | null, tours: readonly EditTour[]): TourPick {
  if (tours.length === 0) return { kind: 'missing' };
  if (words === null) return tours.length === 1 ? { kind: 'one', tour: tours[0]! } : { kind: 'choose', tours: [...tours] };
  const q = tokens(words);
  if (q.length === 0) return { kind: 'missing' };
  const exact = tours.filter((t) => tokens(t.title).join(' ') === q.join(' '));
  if (exact.length === 1) return { kind: 'one', tour: exact[0]! };
  const hits = tours.filter((t) => {
    const tt = tokens(t.title);
    return q.every((w) => tt.some((x) => tokenMatches(w, x)));
  });
  if (hits.length === 0) return { kind: 'missing' };
  if (hits.length === 1) return { kind: 'one', tour: hits[0]! };
  return { kind: 'choose', tours: hits };
}

