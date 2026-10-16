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

// ── Одно число в разных записях (аудит 15.10, ZH-NUMERALS) ──────────────
//
// Прогон перевода 4 (16.10) отверг все пять полей партии сверкой чисел:
// «появились числа 2, 4», «6, 10», «7, 10», «9»; «нет чисел 1, 6». Сверка
// видела только цифры, а одно число пишется по-разному: в русском исходнике
// словом («два дня», «четырёхчасовой облёт», «первый день»), в переводе
// цифрой («2天», «4小时», «第1天») или китайской цифрой («六个小时»).
//
// Правило асимметрично намеренно:
//   - лишнее АРАБСКОЕ число перевода допустимо, только если оно есть в
//     исходнике цифрой или словом. Китайские цифры для этой проверки не
//     берутся: 一 стоит в 一起 «вместе», 十 — в 十分 «очень», и они дали бы
//     «лишние» числа там, где их нет;
//   - число, записанное в исходнике ЦИФРАМИ, сохранено, если в переводе оно
//     есть цифрой или китайской записью. Число, записанное в исходнике словом,
//     в переводе не требуется — как не требовалось и до правки: по-китайски
//     «двухместный» — 双人, «в первой половине дня» — 上午, «в первую
//     очередь» — 首先, и цифры там нет. Требовать её значило бы завести новые
//     ложные отказы, которых прогон не мерил.

/** Количественные числительные во всех падежах (ё → е). «Полтора» — нет: это не целое. */
const RU_CARDINALS: ReadonlyMap<string, number> = (() => {
  const m = new Map<string, number>();
  const put = (n: number, ...forms: string[]) => { for (const f of forms) m.set(f, n); };
  // Множественное «одни/одних» не взято: это «только, сами по себе», а не число.
  put(1, 'один', 'одна', 'одно', 'одного', 'одной', 'одному', 'одним', 'одном', 'одну', 'одною');
  put(2, 'два', 'две', 'двух', 'двум', 'двумя');
  put(3, 'три', 'трех', 'трем', 'тремя');
  put(4, 'четыре', 'четырех', 'четырем', 'четырьмя');
  put(5, 'пять', 'пяти', 'пятью');
  put(6, 'шесть', 'шести', 'шестью');
  // «семью» не взято: это и вин. от «семья» — «подходит, чтобы взять семью».
  put(7, 'семь', 'семи');
  put(8, 'восемь', 'восьми', 'восемью', 'восьмью');
  put(9, 'девять', 'девяти', 'девятью');
  put(10, 'десять', 'десяти', 'десятью');
  const teens = ['одиннадцат', 'двенадцат', 'тринадцат', 'четырнадцат', 'пятнадцат', 'шестнадцат', 'семнадцат', 'восемнадцат', 'девятнадцат'];
  teens.forEach((stem, i) => put(11 + i, `${stem}ь`, `${stem}и`, `${stem}ью`));
  put(20, 'двадцать', 'двадцати', 'двадцатью');
  put(30, 'тридцать', 'тридцати', 'тридцатью');
  put(40, 'сорок', 'сорока');
  put(50, 'пятьдесят', 'пятидесяти', 'пятьюдесятью');
  put(60, 'шестьдесят', 'шестидесяти', 'шестьюдесятью');
  put(70, 'семьдесят', 'семидесяти', 'семьюдесятью');
  put(80, 'восемьдесят', 'восьмидесяти', 'восемьюдесятью');
  put(90, 'девяносто', 'девяноста');
  put(100, 'сто', 'ста');
  put(200, 'двести', 'двухсот', 'двумстам', 'двумястами', 'двухстах');
  put(300, 'триста', 'трехсот', 'тремстам', 'тремястами', 'трехстах');
  put(400, 'четыреста', 'четырехсот', 'четырьмстам', 'четырьмястами', 'четырехстах');
  put(500, 'пятьсот', 'пятисот', 'пятистам', 'пятьюстами', 'пятистах');
  put(600, 'шестьсот', 'шестисот', 'шестистам', 'шестьюстами', 'шестистах');
  put(700, 'семьсот', 'семисот', 'семистам', 'семьюстами', 'семистах');
  put(800, 'восемьсот', 'восьмисот', 'восьмистам', 'восемьюстами', 'восьмистах');
  put(900, 'девятьсот', 'девятисот', 'девятистам', 'девятьюстами', 'девятистах');
  return m;
})();

/** Порядковые первый…десятый во всех родах и падежах (ё → е). */
const RU_ORDINALS: ReadonlyMap<string, number> = (() => {
  const m = new Map<string, number>();
  const endings = ['ый', 'ой', 'ая', 'ое', 'ые', 'ого', 'ому', 'ым', 'ом', 'ую', 'ых', 'ыми', 'ою'];
  const stems: Array<[number, string]> = [
    [1, 'перв'], [2, 'втор'], [4, 'четверт'], [5, 'пят'], [6, 'шест'], [7, 'седьм'], [8, 'восьм'], [9, 'девят'], [10, 'десят'],
  ];
  for (const [n, stem] of stems) for (const e of endings) m.set(stem + e, n);
  for (const f of ['третий', 'третья', 'третье', 'третьи', 'третьего', 'третьему', 'третьим', 'третьем', 'третьей', 'третью', 'третьих', 'третьими']) m.set(f, 3);
  return m;
})();

/**
 * Сложные прилагательные с числом впереди: «четырёхчасовой», «однодневный»,
 * «двухместный», «десятичасовая». Вторая часть — из явного списка корней
 * меры: без него «семинар» дал бы 7, «стоянка» и «столица» — 100.
 */
const RU_COMPOUND_HEADS: ReadonlyArray<readonly [string, number]> = [
  ['одно', 1], ['дву', 2], ['двух', 2], ['трех', 3], ['четырех', 4], ['пяти', 5], ['шести', 6], ['семи', 7],
  ['восьми', 8], ['девяти', 9], ['десяти', 10], ['двенадцати', 12], ['пятнадцати', 15],
  ['двадцати', 20], ['тридцати', 30], ['сорока', 40], ['пятидесяти', 50], ['сто', 100],
];
const RU_COMPOUND_ROOTS = [
  'дневн', 'суточн', 'часов', 'минутн', 'недельн', 'месячн', 'летн', 'местн', 'этажн', 'разов', 'кратн',
  'километров', 'метров', 'спальн', 'комнатн', 'звездн', 'звездочн', 'процентн',
];

function compoundNumber(word: string): number | null {
  for (const [head, n] of RU_COMPOUND_HEADS) {
    if (!word.startsWith(head)) continue;
    const rest = word.slice(head.length);
    if (RU_COMPOUND_ROOTS.some((root) => rest.startsWith(root))) return n;
  }
  return null;
}

/** Разряд числительного: 0 — единицы, 1 — десять…девятнадцать, 2 — десятки, 3 — сотни. */
function rankOf(n: number): number {
  if (n >= 100) return 3;
  if (n >= 20) return 2;
  if (n >= 10) return 1;
  return 0;
}

/** Склеивается только младший разряд после старшего: «сто двадцать», «двадцать пять»; «десять пять» — два числа. */
function joins(prevRank: number, nextRank: number): boolean {
  if (prevRank === 3) return nextRank < 3;
  if (prevRank === 2) return nextRank === 0;
  return false;
}

/**
 * Числа, записанные в русском тексте словами. Соседние числительные через
 * пробел складываются по разрядам («двадцать пять» → 25); через дефис или
 * запятую — нет («два-три дня» — это 2 и 3).
 */
export function russianWordNumbersOf(s: string): Set<string> {
  const out = new Set<string>();
  const tokens = s.toLowerCase().replace(/ё/g, 'е').match(/[а-я]+|[^а-я]+/g) ?? [];
  let acc: number | null = null;
  let accRank = 0;
  const flush = () => {
    if (acc !== null) out.add(String(acc));
    acc = null;
  };
  for (const tok of tokens) {
    if (!/[а-я]/.test(tok)) {
      if (!/^[ \t ]+$/.test(tok)) flush();
      continue;
    }
    const n = RU_CARDINALS.get(tok) ?? RU_ORDINALS.get(tok);
    if (n === undefined) {
      flush();
      const c = compoundNumber(tok);
      if (c !== null) out.add(String(c));
      continue;
    }
    const r = rankOf(n);
    if (acc !== null && joins(accRank, r)) {
      acc += n;
    } else {
      flush();
      acc = n;
    }
    accRank = r;
  }
  flush();
  return out;
}

const ZH_DIGITS: Readonly<Record<string, number>> = {
  '〇': 0, '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
};

/**
 * Слова, где китайская цифра — не число: 一起 «вместе», 十分 «очень»,
 * 三文鱼 «лосось» (на Камчатке — в каждом рыболовном туре), 四季 «круглый
 * год». Они вырезаются до разбора, иначе число исходника «нашлось» бы в
 * переводе там, где его нет. 百分之 — «процент»: 百分之五十 — это 50, а не 100.
 */
const ZH_NOT_NUMBERS = [
  '一起', '一些', '一直', '一样', '一定', '一般', '一切', '一同', '一旦', '一下', '一边', '一路', '一流',
  '一致', '一带', '万一', '统一', '十分', '十足', '三文鱼', '四周', '四处', '四季', '五颜六色', '五彩', '百分之',
];

/** Значение записи с разрядами: 十二 → 12, 二十五 → 25, 一百零五 → 105, 百 → 100. */
function zhWithUnits(run: string): number {
  let total = 0;
  let cur = 0;
  for (const ch of run) {
    if (ch === '十') {
      total += (cur || 1) * 10;
      cur = 0;
    } else if (ch === '百') {
      total += (cur || 1) * 100;
      cur = 0;
    } else {
      cur = ZH_DIGITS[ch] ?? 0;
    }
  }
  return total + cur;
}

/**
 * Числа, записанные китайскими цифрами. Только для проверки «число исходника
 * не потеряно» — почему, сказано в шапке раздела.
 */
export function chineseNumeralsOf(s: string): Set<string> {
  let text = s;
  for (const w of ZH_NOT_NUMBERS) text = text.split(w).join(' ');
  const out = new Set<string>();
  for (const [run] of text.matchAll(/[〇零一二两三四五六七八九十百]+/g)) {
    if (/[十百]/.test(run)) {
      out.add(String(zhWithUnits(run)));
    } else if (run.length === 2 && !/[〇零]/.test(run)) {
      // 三四天 — «три-четыре дня»: два числа подряд, а не 34.
      for (const ch of run) out.add(String(ZH_DIGITS[ch]));
    } else {
      // Одна цифра или запись по цифре: 二〇二六 — год 2026.
      out.add(String(Number([...run].map((ch) => ZH_DIGITS[ch]).join(''))));
    }
  }
  return out;
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
  // Одно число в разных записях — шапка раздела «Одно число в разных записях».
  const srcDigits = numbersOf(source);
  const srcAny = new Set([...srcDigits, ...russianWordNumbersOf(source)]);
  const zhDigits = numbersOf(t);
  const zhAny = new Set([...zhDigits, ...chineseNumeralsOf(t)]);
  const lost = [...srcDigits].filter((n) => !zhAny.has(n));
  if (lost.length) return `в переводе нет чисел исходника: ${lost.slice(0, 5).join(', ')}`;
  const added = [...zhDigits].filter((n) => !srcAny.has(n));
  if (added.length) return `в переводе появились числа, которых нет в исходнике: ${added.slice(0, 5).join(', ')}`;
  const zhLower = t.toLowerCase();
  const lostLatin = [...latinWordsOf(source)].filter((w) => !zhLower.includes(w));
  if (lostLatin.length) return `в переводе пропали латинские слова: ${lostLatin.slice(0, 5).join(', ')}`;
  return null;
}

