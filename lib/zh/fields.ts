/**
 * Поля машинного перевода на китайский — чистая часть, без базы и без модели
 * (аудит 15.10, CN-pages). Что переводится, как нормализуется исходник, как
 * считается хэш устаревания, как перевод хранится и читается при показе, как
 * сверяется с исходником. Модель зовёт lib/zh/translate; страницы и крон
 * читают отсюда — экрану не нужно тянуть водопад провайдеров.
 *
 * Почему так устроено — шапка lib/zh/translate.ts.
 */

import { createHash } from 'node:crypto';
import { htmlToText } from '@/lib/html/text';
import { programSteps } from '@/lib/tours/describe';

/** Язык перевода — тот же код, что у раздела /zh (lib/zh/pages). */
export const ZH_LANG = 'zh-CN';

export type ZhEntityType = 'tour' | 'place';

/** Форма поля: строка, список строк или программа дня [{title, text}]. */
export type ZhFieldKind = 'text' | 'list' | 'program';

/** Поля тура, которые переводит модель. Всё прочее — из базы при показе. */
export const ZH_TOUR_FIELDS = {
  title: 'text',
  short_description: 'text',
  description: 'text',
  program: 'program',
  included: 'list',
  not_included: 'list',
  what_to_bring: 'list',
} as const satisfies Record<string, ZhFieldKind>;

/** Поля места, которые переводит модель. Имя места — только из источника (OSM name:zh). */
export const ZH_PLACE_FIELDS = {
  description: 'text',
} as const satisfies Record<string, ZhFieldKind>;

export type ZhTourField = keyof typeof ZH_TOUR_FIELDS;
export type ZhPlaceField = keyof typeof ZH_PLACE_FIELDS;

export interface ZhProgramStep { title: string; text: string }
export type ZhFieldValue = string | string[] | ZhProgramStep[];

/**
 * Путь вызова модели, который пишется в content_translations.model. Не id
 * модели: обёртки водопада его не возвращают, а догадка рядом с фактом —
 * тот самый «объявленный исход без источника» (§4.0).
 */
export const ZH_MODEL_PATH = 'ai-quality';

/**
 * Версия правила нормализации и промпта. Входит в хэш: поменялось правило —
 * все переводы считаются устаревшими и переводятся заново, а не выдают себя
 * за перевод по новым правилам.
 */
const HASH_VERSION = 'zh-v1';

// ── Нормализация исходника ──────────────────────────────────────────────

/**
 * Значение поля из базы → каноническая форма. null — переводить нечего
 * (поле пустое или чужой формы). Текст очищается от разметки с сохранением
 * абзацев: описания мест бывают с HTML, а в модель и на экран идёт текст.
 */
export function normalizeSource(kind: ZhFieldKind, raw: unknown): ZhFieldValue | null {
  if (kind === 'text') {
    if (typeof raw !== 'string') return null;
    const text = htmlToText(raw).trim();
    return text ? text : null;
  }
  if (kind === 'list') {
    if (!Array.isArray(raw)) return null;
    const items = raw.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean);
    return items.length ? items : null;
  }
  const steps = programSteps(raw);
  return steps.length ? steps : null;
}

/** SHA-256 нормализованного поля (64 hex) — по нему видно устаревание. */
export function sourceHash(kind: ZhFieldKind, value: ZhFieldValue): string {
  return createHash('sha256').update(`${HASH_VERSION}\n${kind}\n${JSON.stringify(value)}`).digest('hex');
}

// ── Сегменты: что именно уходит в модель ────────────────────────────────

/** Плоский список непустых строк поля, в порядке показа. */
export function toSegments(kind: ZhFieldKind, value: ZhFieldValue): string[] {
  if (kind === 'text') return [value as string];
  if (kind === 'list') return [...(value as string[])];
  const out: string[] = [];
  for (const s of value as ZhProgramStep[]) {
    out.push(s.title);
    if (s.text) out.push(s.text);
  }
  return out;
}

/**
 * Перевод сегментов → значение той же формы, что исходник. Число сегментов не
 * сошлось — null: перевод не того поля, а не «почти перевод».
 */
export function fromSegments(kind: ZhFieldKind, source: ZhFieldValue, segs: readonly string[]): ZhFieldValue | null {
  const need = toSegments(kind, source).length;
  if (segs.length !== need) return null;
  if (kind === 'text') return segs[0];
  if (kind === 'list') return [...segs];
  const out: ZhProgramStep[] = [];
  let i = 0;
  for (const s of source as ZhProgramStep[]) {
    const title = segs[i++];
    const text = s.text ? segs[i++] : '';
    out.push({ title, text });
  }
  return out;
}

// ── Хранение ────────────────────────────────────────────────────────────

/** Значение → текст колонки: строка как есть, список и программа — JSON. */
export function encodeStored(kind: ZhFieldKind, value: ZhFieldValue): string {
  return kind === 'text' ? (value as string) : JSON.stringify(value);
}

/**
 * Текст колонки → значение той же формы, что живой исходник. Чужая форма или
 * другая длина — null (такой перевод не показывается: он не от этого поля).
 */
export function decodeStored(kind: ZhFieldKind, stored: string, source: ZhFieldValue): ZhFieldValue | null {
  if (kind === 'text') return stored.trim() ? stored : null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  if (kind === 'list') {
    const src = source as string[];
    if (parsed.length !== src.length || !parsed.every((x) => typeof x === 'string' && x.trim())) return null;
    return parsed as string[];
  }
  const src = source as ZhProgramStep[];
  if (parsed.length !== src.length) return null;
  const out: ZhProgramStep[] = [];
  for (let i = 0; i < src.length; i++) {
    const p = parsed[i] as { title?: unknown; text?: unknown } | null;
    if (!p || typeof p.title !== 'string' || !p.title.trim()) return null;
    const text = typeof p.text === 'string' ? p.text : '';
    // Текст шага есть в исходнике — обязан быть и в переводе, и наоборот.
    if (Boolean(src[i].text) !== Boolean(text.trim())) return null;
    out.push({ title: p.title, text });
  }
  return out;
}

/** Строка content_translations, нужная для показа. */
export interface ZhStoredTranslation {
  field: string;
  text: string;
  source_hash: string;
  translated_at: Date | string | null;
  reviewed_at: Date | string | null;
}

/**
 * Что показывать вместо поля. Пять исходов, и ни один не равен другому:
 *   none     — поля в исходнике нет, показывать нечего;
 *   fresh    — перевод есть и сделан с нынешнего текста;
 *   stale    — перевод есть, но исходник с тех пор менялся;
 *   missing  — перевода нет (или он чужой формы);
 *   unknown  — переводы не прочитались (отказ базы): «не знаю» ≠ «нет».
 */
export type ZhFieldView =
  | { state: 'none' }
  | { state: 'fresh'; source: ZhFieldValue; zh: ZhFieldValue; translatedAt: Date | null; reviewed: boolean }
  | { state: 'stale' | 'missing' | 'unknown'; source: ZhFieldValue };

function asDate(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Поле для показа. `rows` — переводы сущности по имени поля; null — их не
 * удалось прочитать.
 */
export function readField(
  kind: ZhFieldKind,
  raw: unknown,
  rows: ReadonlyMap<string, ZhStoredTranslation> | null,
  field: string,
): ZhFieldView {
  const source = normalizeSource(kind, raw);
  if (source === null) return { state: 'none' };
  if (rows === null) return { state: 'unknown', source };
  const row = rows.get(field);
  if (!row) return { state: 'missing', source };
  if (row.source_hash !== sourceHash(kind, source)) return { state: 'stale', source };
  const zh = decodeStored(kind, row.text, source);
  if (zh === null) {
    // Хэш свежий, а форма не сходится с исходником: строка в базе испорчена.
    // Это дефект записи, а не «перевода нет» — вслух, без текста поля.
    console.error('[zh] перевод в базе не читается (форма не сходится с исходником), поле:', field);
    return { state: 'missing', source };
  }
  return { state: 'fresh', source, zh, translatedAt: asDate(row.translated_at), reviewed: row.reviewed_at != null };
}

// ── Сверка перевода с исходником ────────────────────────────────────────

const HAN = /\p{Script=Han}/u;
const CYRILLIC = /\p{Script=Cyrillic}/u;

/** Полноширинные цифры → обычные; разделители тысяч внутри числа убраны. */
function normalizeDigits(s: string): string {
  return s
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/(\d)[\s  ,'’](?=\d{3}(?!\d))/g, '$1');
}

/** Множество чисел текста (цифровые последовательности). */
export function numbersOf(s: string): Set<string> {
  return new Set(normalizeDigits(s).match(/\d+/g) ?? []);
}

/** Латинские слова от двух букв, кроме плейсхолдеров чистки в квадратных скобках. */
export function latinWordsOf(s: string): Set<string> {
  const plain = s.replace(/\[[^\]]*\]/g, ' ');
  return new Set((plain.match(/[A-Za-z][A-Za-z0-9]+/g) ?? []).map((w) => w.toLowerCase()));
}

/**
 * Сверка одного сегмента. null — сходится; строка — почему перевод не принят.
 * Это не оценка качества, а отсев того, что точно не перевод этого текста.
 */
export function checkSegment(source: string, zh: string): string | null {
  const t = zh.trim();
  if (!t) return 'модель вернула пустую строку — перевода нет';
  if (CYRILLIC.test(source) && !HAN.test(t)) return 'в переводе нет иероглифов — вернулся не перевод';
  const srcNums = numbersOf(source);
  const zhNums = numbersOf(t);
  const lost = [...srcNums].filter((n) => !zhNums.has(n));
  if (lost.length) return `в переводе нет чисел исходника: ${lost.slice(0, 5).join(', ')}`;
  const added = [...zhNums].filter((n) => !srcNums.has(n));
  if (added.length) return `в переводе появились числа, которых нет в исходнике: ${added.slice(0, 5).join(', ')}`;
  const zhLower = t.toLowerCase();
  const lostLatin = [...latinWordsOf(source)].filter((w) => !zhLower.includes(w));
  if (lostLatin.length) return `в переводе пропали латинские слова: ${lostLatin.slice(0, 5).join(', ')}`;
  return null;
}

