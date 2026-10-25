/**
 * Команда прокатчика: новая цена или новое описание машины.
 *
 * Пишет человек, не модель. Цена — целое число рублей из его сообщения.
 * Описание — его слова после двоеточия, в колонку conditions живой строки,
 * и только после одобрения. Фото команда не принимает.
 *
 * Канал MAX шлёт HTML: название и текст в ответе экранируются.
 */

import { escapeHtml } from '@/lib/text/escape-html';
import { formatRub } from '@/lib/transfers/charter-format';

/** Как в car_rental_offers.price_rub_per_day: INTEGER > 0. */
const PRICE_MAX = 2_147_483_647;
/** Сообщение MAX и так короче; длиннее — не обрезаем молча, а не записываем. */
export const OFFER_EDIT_TEXT_MAX = 2000;
const TITLE_MAX = 120;

export type OfferEditCommand =
  | {
    kind: 'price';
    title: string;
    priceRub: number;
    /**
     * Название кончается коротким числом, а цена — три цифры: «Jimny 8 500»
     * читается и как «Jimny 8» за 500, и как «Jimny» за 8 500. Какое верно,
     * решает прайс прокатчика, а не форма фразы.
     */
    alsoReadsAs?: { title: string; spacedPrice: string };
  }
  | { kind: 'conditions'; title: string; conditions: string };

export type OfferEditParse =
  | { ok: true; command: OfferEditCommand }
  | { ok: false; reason: 'not_edit' | 'format' | 'bad_price' | 'empty_text' | 'too_long' | 'title_long' };

const QUESTION_END = /[?？]\s*$/u;

/**
 * Сообщение начинается как команда правки. Остальной разговор сюда не попадает.
 * Вопрос («Цена на Jimny какая?», «описание Tank-300?») — не команда: его
 * отвечает помощник по прайсу. Описание с двоеточием — команда, даже если
 * текст кончается вопросом.
 */
export function isOfferEditAsk(text: string): boolean {
  const t = text.trim();
  if (/^цен[ау](?:\s|$)/i.test(t)) return !QUESTION_END.test(t);
  if (/^описание(?:\s|$)/i.test(t)) return t.includes(':') || !QUESTION_END.test(t);
  return false;
}

export function parseOfferEdit(text: string): OfferEditParse {
  const raw = text.trim();
  if (!isOfferEditAsk(raw)) return { ok: false, reason: 'not_edit' };

  if (/^цен[ау](?:\s|$)/i.test(raw)) {
    const m = raw.match(/^цен[ау]\s+(.+?)\s+(\d{1,10})\s*$/i);
    if (!m) return { ok: false, reason: 'format' };
    const title = m[1].trim();
    if (title.length === 0 || title.length > TITLE_MAX) return { ok: false, reason: 'title_long' };
    const price = Number(m[2]);
    if (!Number.isSafeInteger(price) || price < 1 || price > PRICE_MAX) return { ok: false, reason: 'bad_price' };
    // «Land Cruiser 200 15000» — машина с числом в названии. «Jimny 8 500» —
    // цена с пробелом между тысячами. Второе прочтение возможно, только когда
    // за коротким числом идут ровно три цифры; тогда прайс скажет, есть ли
    // машина без этого числа.
    const tail = /^\d{3}$/.test(m[2]) ? /^(.+?)\s+(\d{1,3})$/.exec(title) : null;
    const command: OfferEditCommand = tail
      ? { kind: 'price', title, priceRub: price, alsoReadsAs: { title: tail[1].trim(), spacedPrice: `${tail[2]} ${m[2]}` } }
      : { kind: 'price', title, priceRub: price };
    return { ok: true, command };
  }

  const m = raw.match(/^описание\s+(.+?)\s*:\s*([\s\S]+)$/i);
  if (!m) return { ok: false, reason: 'format' };
  const title = m[1].trim();
  if (title.length === 0 || title.length > TITLE_MAX) return { ok: false, reason: 'title_long' };
  const conditions = m[2].trim();
  if (conditions.length === 0) return { ok: false, reason: 'empty_text' };
  if (conditions.length > OFFER_EDIT_TEXT_MAX) return { ok: false, reason: 'too_long' };
  return { ok: true, command: { kind: 'conditions', title, conditions } };
}

export function offerEditFormatHint(): string {
  return 'Напишите отдельным сообщением. Цена: слово «цена», название как в списке, рубли за сутки одним числом без пробела. '
    + 'Описание: слово «описание», название, двоеточие и текст. Название — целиком, как в списке машин. '
    + 'Это черновик: на сайте остаётся текущая строка, пока правку не одобрят. Фото эта команда не меняет.';
}

export function offerEditRejectText(reason: OfferEditParse & { ok: false }): string {
  switch (reason.reason) {
    case 'bad_price':
      return 'Цена — целое число рублей больше нуля, без пробелов и без копеек. Черновик не записан, на сайте ничего не изменилось.';
    case 'empty_text':
      return 'После двоеточия нет текста описания. Черновик не записан, на сайте ничего не изменилось.';
    case 'too_long':
      return `Описание длиннее ${OFFER_EDIT_TEXT_MAX} знаков — целиком не сохраняю и не обрезаю. Черновик не записан, на сайте ничего не изменилось.`;
    case 'title_long':
      return 'Название машины не разобрано или длиннее строки прайса. Напишите его как в списке машин. Черновик не записан.';
    default:
      return offerEditFormatHint();
  }
}

export function offerEditMissingText(title: string): string {
  return `В прайсе нет машины с названием «${escapeHtml(title)}». Напишите название как в списке машин. Черновик не записан, на сайте ничего не изменилось.`;
}

/**
 * Фраза читается и как машина «Jimny 8» с ценой 500, и как машина «Jimny»
 * с ценой «8 500», а машина «Jimny» в прайсе есть. Число не выбираю.
 */
export function offerEditSpacedPriceText(title: string, spacedPrice: string): string {
  return `Не понял цену: «${escapeHtml(spacedPrice)}» — это одно число или часть названия? `
    + `Если цена машины «${escapeHtml(title)}», напишите её одним числом без пробела. `
    + 'Черновик не записан, на сайте ничего не изменилось.';
}

export function offerEditAmbiguousText(title: string, count: number): string {
  return `Названию «${escapeHtml(title)}» подходят ${count} машины. Не выбираю сам. Напишите название целиком, как в списке. Черновик не записан.`;
}

export function offerEditDbErrorText(): string {
  return 'Не смог записать черновик. Прайс на сайте не изменён. Попробуйте ещё раз.';
}

export function offerEditSavedText(row: {
  title: string;
  kind: 'price' | 'conditions';
  livePrice: number;
  priceIsFrom: boolean;
  liveConditions: string | null;
  draftPrice: number | null;
  draftConditions: string | null;
}): string {
  const title = escapeHtml(row.title);
  const lines = [`Черновик записан: «${title}». На сайте пока прежняя строка — правка появится после одобрения.`];
  if (row.kind === 'price' && row.draftPrice !== null) {
    lines.push(`Новая цена за сутки: ${formatRub(row.draftPrice)}. Сейчас в прайсе: ${formatRub(row.livePrice)}.`);
    if (row.priceIsFrom) {
      lines.push('В прайсе цена записана как «от». Черновик меняет число и эту пометку не снимает.');
    }
  }
  if (row.kind === 'conditions' && row.draftConditions !== null) {
    const was = row.liveConditions && row.liveConditions.trim().length > 0
      ? escapeHtml(row.liveConditions.trim())
      : 'описания в прайсе не было';
    lines.push(`Новое описание: ${escapeHtml(row.draftConditions)}`);
    lines.push(`Сейчас на сайте: ${was}.`);
  }
  lines.push('Фото эта команда не меняет.');
  return lines.join('\n');
}
