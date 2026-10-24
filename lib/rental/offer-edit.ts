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
  | { kind: 'price'; title: string; priceRub: number }
  | { kind: 'conditions'; title: string; conditions: string };

export type OfferEditParse =
  | { ok: true; command: OfferEditCommand }
  | { ok: false; reason: 'not_edit' | 'format' | 'bad_price' | 'empty_text' | 'too_long' | 'title_long' };

/** Сообщение начинается как команда правки. Остальной разговор сюда не попадает. */
export function isOfferEditAsk(text: string): boolean {
  const t = text.trim();
  return /^цен[ау](?:\s|$)/i.test(t) || /^описание(?:\s|$)/i.test(t);
}

export function parseOfferEdit(text: string): OfferEditParse {
  const raw = text.trim();
  if (!isOfferEditAsk(raw)) return { ok: false, reason: 'not_edit' };

  if (/^цен[ау](?:\s|$)/i.test(raw)) {
    const m = raw.match(/^цен[ау]\s+(.+?)\s+(\d{1,10})\s*$/i);
    if (!m) return { ok: false, reason: 'format' };
    const title = m[1].trim();
    if (title.length === 0 || title.length > TITLE_MAX) return { ok: false, reason: 'title_long' };
    // «8 500» разобралось бы как машина «… 8» и цена 500. Не выбираю число сам.
    if (/(?:^|\s)\d{1,3}$/.test(title)) return { ok: false, reason: 'format' };
    const price = Number(m[2]);
    if (!Number.isSafeInteger(price) || price < 1 || price > PRICE_MAX) return { ok: false, reason: 'bad_price' };
    return { ok: true, command: { kind: 'price', title, priceRub: price } };
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
  return 'Напишите отдельным сообщением: «цена <название как в прайсе> <рубли за сутки одним числом, без пробела>» '
    + 'или «описание <название>: текст». Название — целиком, как в списке машин. '
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
