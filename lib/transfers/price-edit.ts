/**
 * Правка прайса перевозчика — чистая часть: формы черновика, команда в чате
 * и тексты (#2862 этап C, миграция 1355).
 *
 * Правило то же, что у проката (lib/rental/offer-edit): партнёр пишет
 * черновик, живая строка transfer_charter_prices меняется только одобрением
 * администратора. Здесь ни базы, ни сети: модуль читают кабинет на сайте,
 * чат-кабинет и очередь модерации.
 *
 * Команда в чате — одна: «цена <направление или час/день/доплата> <рубли>».
 * Примечание, условия и новую строку словами в чате не принимаем: у
 * направления есть форма (откуда, куда, вид машины), и угадывать её по
 * фразе значило бы записать в прайс выдумку. Это делается в кабинете на
 * сайте формой.
 */

import { escapeHtml } from '@/lib/text/escape-html';
import {
  formatRub, rateLabel, vehicleKindWord, type CharterRateUnit, type CharterVehicleKind,
} from '@/lib/transfers/charter-format';

export const CHARTER_VEHICLE_KINDS: readonly CharterVehicleKind[] = ['jeep', 'vahtovka', 'minibus', 'other'];
export type CharterLineKind = 'destination' | 'extra_day' | 'per_hour' | 'per_day';
export const CHARTER_LINE_KINDS: readonly CharterLineKind[] = ['destination', 'extra_day', 'per_hour', 'per_day'];

/** Как в transfer_charter_prices.price_rub: INTEGER > 0. */
export const PRICE_RUB_MAX = 2_147_483_647;
export const PRICE_NOTE_MAX = 255;
export const PRICE_CONDITIONS_MAX = 2000;
export const PRICE_TEXT_MAX = 255;

/** Живая строка прайса глазами перевозчика — и скрытая тоже: в кабинете видно, что снято с сайта. */
export interface CharterPriceRow {
  id: string;
  vehicleKind: CharterVehicleKind;
  lineKind: CharterLineKind;
  fromText: string | null;
  toText: string | null;
  priceRub: number;
  priceNote: string | null;
  conditions: string | null;
  validYear: number | null;
  isActive: boolean;
}

/** Что черновик меняет в существующей строке. null — поле не меняется. */
export interface CharterPricePatch {
  priceRub: number | null;
  priceNote: string | null;
  conditions: string | null;
  isActive: boolean | null;
}

/** Черновик новой строки прайса — вся форма живой строки. */
export interface CharterPriceNewRow {
  vehicleKind: CharterVehicleKind;
  lineKind: CharterLineKind;
  fromText: string | null;
  toText: string | null;
  priceRub: number;
  priceNote: string | null;
  conditions: string | null;
  validYear: number | null;
}

export type NewRowShape =
  | { ok: true }
  | { ok: false; reason: 'destination_needs_texts' | 'rate_has_texts' | 'bad_price' | 'text_long' | 'bad_year' };

/** Форма новой строки — та же, что CHECK в базе: несошедшееся не уходит в запрос. */
export function checkNewRowShape(row: CharterPriceNewRow): NewRowShape {
  if (!Number.isSafeInteger(row.priceRub) || row.priceRub < 1 || row.priceRub > PRICE_RUB_MAX) return { ok: false, reason: 'bad_price' };
  if (row.lineKind === 'destination') {
    if (!row.fromText?.trim() || !row.toText?.trim()) return { ok: false, reason: 'destination_needs_texts' };
  } else if (row.fromText !== null || row.toText !== null) {
    return { ok: false, reason: 'rate_has_texts' };
  }
  for (const t of [row.fromText, row.toText, row.priceNote]) {
    if (t !== null && t.length > PRICE_TEXT_MAX) return { ok: false, reason: 'text_long' };
  }
  if (row.conditions !== null && row.conditions.length > PRICE_CONDITIONS_MAX) return { ok: false, reason: 'text_long' };
  if (row.validYear !== null && (!Number.isInteger(row.validYear) || row.validYear < 2020 || row.validYear > 2100)) return { ok: false, reason: 'bad_year' };
  return { ok: true };
}

/** Черновик ничего не меняет — записывать нечего. */
export function patchIsEmpty(p: CharterPricePatch): boolean {
  return p.priceRub === null && p.priceNote === null && p.conditions === null && p.isActive === null;
}

/**
 * Подпись строки прайса словами: направление — «Петропавловск — Авачинский»,
 * тариф — «Час работы машины», доплата — «Доплата за день на месте». Вид
 * машины — всегда: в кабинете строки разных видов стоят рядом.
 */
export function priceRowLabel(row: Pick<CharterPriceRow, 'lineKind' | 'fromText' | 'toText' | 'vehicleKind'>): string {
  const kind = vehicleKindWord(row.vehicleKind);
  switch (row.lineKind) {
    case 'destination': return `${row.fromText ?? '?'} — ${row.toText ?? '?'} (${kind})`;
    case 'extra_day': return `Доплата за день на месте (${kind})`;
    case 'per_hour': return `${rateLabel('hour')} (${kind})`;
    case 'per_day': return `${rateLabel('day')} (${kind})`;
  }
}

export const LINE_KIND_LABEL: Readonly<Record<CharterLineKind, string>> = {
  destination: 'Направление: цена за машину',
  extra_day: 'Доплата за день работы на месте',
  per_hour: rateLabel('hour'),
  per_day: rateLabel('day'),
};

export const VEHICLE_KIND_LABEL: Readonly<Record<CharterVehicleKind, string>> = {
  jeep: 'Джип',
  vahtovka: 'Вахтовка',
  minibus: 'Микроавтобус',
  other: 'Другое',
};

// ── Команда в чате ──────────────────────────────────────────────────────────

export type CharterPriceTarget =
  | { kind: 'destination'; words: string }
  | { kind: 'rate'; unit: CharterRateUnit }
  | { kind: 'extra_day' };

export type CharterPriceCommand = {
  target: CharterPriceTarget;
  priceRub: number;
  /** «Горелый 8 500»: читается и как цена 500 у «Горелый 8». Решает прайс, не фраза. */
  alsoReadsAs?: { words: string; spacedPrice: string };
};

export type CharterPriceParse =
  | { ok: true; command: CharterPriceCommand }
  | { ok: false; reason: 'not_edit' | 'format' | 'bad_price' | 'words_long' | 'conditions_not_here' };

const QUESTION_END = /[?？]\s*$/u;

/**
 * Сообщение начинается как команда правки цены. Вопрос («цена на Горелый
 * какая?») — не команда. «описание …» перевозчику здесь не принимается, но
 * это тоже его команда, не разговор: ответ скажет, где править.
 */
export function isCharterPriceEditAsk(text: string): boolean {
  const t = text.trim();
  if (/^цен[ау](?:\s|$)/i.test(t)) return !QUESTION_END.test(t);
  if (/^описание(?:\s|$)/i.test(t)) return t.includes(':') || !QUESTION_END.test(t);
  return false;
}

const RATE_WORDS: ReadonlyArray<[RegExp, CharterPriceTarget]> = [
  [/^(?:за\s+)?час(?:\s+работы)?$/i, { kind: 'rate', unit: 'hour' }],
  [/^(?:за\s+)?(?:полный\s+)?день(?:\s+работы)?$/i, { kind: 'rate', unit: 'day' }],
  [/^доплата(?:\s+за\s+день)?(?:\s+на\s+месте)?$|^день\s+на\s+месте$/i, { kind: 'extra_day' }],
];

export function parseCharterPriceEdit(text: string): CharterPriceParse {
  const raw = text.trim();
  if (!isCharterPriceEditAsk(raw)) return { ok: false, reason: 'not_edit' };
  if (/^описание(?:\s|$)/i.test(raw)) return { ok: false, reason: 'conditions_not_here' };

  const m = raw.match(/^цен[ау]\s+(.+?)\s+(\d{1,10})\s*$/i);
  if (!m) return { ok: false, reason: 'format' };
  const words = m[1].trim();
  if (words.length === 0 || words.length > PRICE_TEXT_MAX) return { ok: false, reason: 'words_long' };
  const price = Number(m[2]);
  if (!Number.isSafeInteger(price) || price < 1 || price > PRICE_RUB_MAX) return { ok: false, reason: 'bad_price' };

  const rate = RATE_WORDS.find(([re]) => re.test(words));
  if (rate) return { ok: true, command: { target: rate[1], priceRub: price } };

  // «Горелый 8 500»: цена с пробелом или направление с числом. Решает прайс.
  const tail = /^\d{3}$/.test(m[2]) ? /^(.+?)\s+(\d{1,3})$/.exec(words) : null;
  const command: CharterPriceCommand = tail
    ? { target: { kind: 'destination', words }, priceRub: price, alsoReadsAs: { words: tail[1].trim(), spacedPrice: `${tail[2]} ${m[2]}` } }
    : { target: { kind: 'destination', words }, priceRub: price };
  return { ok: true, command };
}

export function charterPriceFormatHint(): string {
  return 'Напишите отдельным сообщением: слово «цена», направление как в прайсе (куда едет машина) либо «час», «день» или «доплата», '
    + 'и рубли за машину одним числом без пробела. Например: «цена Авачинский 65000». '
    + 'Это черновик: на сайте остаётся прежняя строка, пока правку не одобрят. '
    + 'Примечание, условия, новое направление и вид машины — в кабинете на сайте.';
}

export function charterPriceRejectText(parsed: CharterPriceParse & { ok: false }): string {
  switch (parsed.reason) {
    case 'bad_price':
      return 'Цена — целое число рублей больше нуля, без пробелов и без копеек. Черновик не записан, на сайте ничего не изменилось.';
    case 'words_long':
      return 'Направление не разобрано или длиннее строки прайса. Напишите его как в прайсе. Черновик не записан.';
    case 'conditions_not_here':
      return 'Описание и условия строки прайса перевозчика правятся в кабинете на сайте, раздел «Прайс». В чате — только цена: слово «цена», направление и рубли, например «цена Авачинский 65000». Черновик не записан.';
    default:
      return charterPriceFormatHint();
  }
}

export function charterPriceMissingText(words: string): string {
  return `В прайсе нет направления «${escapeHtml(words)}». Напишите его как в прайсе — или добавьте новую строку в кабинете на сайте. Черновик не записан, на сайте ничего не изменилось.`;
}

export function charterPriceAmbiguousText(words: string, labels: readonly string[]): string {
  const list = labels.slice(0, 6).map((l) => `«${escapeHtml(l)}»`).join(', ');
  return `Под «${escapeHtml(words)}» подходят несколько строк прайса: ${list}. Не выбираю сам. Напишите направление целиком, как в прайсе; строки разных видов машин — в кабинете на сайте. Черновик не записан.`;
}

export function charterPriceSpacedText(words: string, spacedPrice: string): string {
  return `Не понял цену: «${escapeHtml(spacedPrice)}» — это одно число или часть направления? `
    + `Если это цена для «${escapeHtml(words)}», напишите её одним числом без пробела. `
    + 'Черновик не записан, на сайте ничего не изменилось.';
}

export function charterPriceNoRateText(unit: CharterRateUnit | 'extra_day'): string {
  const what = unit === 'extra_day' ? 'доплаты за день на месте' : unit === 'hour' ? 'цены за час' : 'цены за день';
  return `В вашем прайсе нет ${what}. Новую строку прайса добавляют в кабинете на сайте, раздел «Прайс». Черновик не записан.`;
}

export function charterPriceDbErrorText(): string {
  return 'Не смог записать черновик. Прайс на сайте не изменён. Попробуйте ещё раз.';
}

export function charterPriceSavedText(row: { label: string; livePrice: number; draftPrice: number; live: boolean }): string {
  const lines = [
    `Черновик записан: ${escapeHtml(row.label)}. На сайте пока прежняя цена — новая появится после одобрения.`,
    `Новая цена за машину: ${formatRub(row.draftPrice)}. Сейчас в прайсе: ${formatRub(row.livePrice)}.`,
  ];
  if (!row.live) lines.push('Эта строка сейчас скрыта с сайта; черновик цены её не показывает — вернуть строку можно в кабинете на сайте.');
  return lines.join('\n');
}

// ── Что видел модератор ─────────────────────────────────────────────────────

/** Поля черновика, какими их показала карточка модератору. Одобряется только это. */
export interface SeenPriceDraft {
  priceRub: number | null;
  priceNote: string | null;
  conditions: string | null;
  isActive: boolean | null;
  vehicleKind: string | null;
  lineKind: string | null;
  fromText: string | null;
  toText: string | null;
  validYear: number | null;
}

export function seenMatches(row: SeenPriceDraft, seen: SeenPriceDraft): boolean {
  return row.priceRub === seen.priceRub
    && row.priceNote === seen.priceNote
    && row.conditions === seen.conditions
    && row.isActive === seen.isActive
    && row.vehicleKind === seen.vehicleKind
    && row.lineKind === seen.lineKind
    && row.fromText === seen.fromText
    && row.toText === seen.toText
    && row.validYear === seen.validYear;
}
