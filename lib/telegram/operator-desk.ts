/**
 * Тексты кабинета туроператора в мессенджере.
 * Клавиатура и команды — то, что человек нажимает на телефоне.
 * Цены туров собирает вызывающий из каталога; здесь только форма строки.
 */

import { pool } from '@/lib/db-pool';
import { escapeHtml } from '@/lib/text/escape-html';
import { priceFromUnit } from '@/lib/tours/price-label';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { tourPath } from '@/lib/tours/tour-url';
import { getPublicBaseUrl } from '@/lib/config';
import { calendarLink } from '@/lib/operators/chat-dates/texts';
import { chatAnswerButtons, chatAnswerOfInbox } from '@/lib/requests/chat-answer';
import { inboxMenuText } from '@/lib/roles/inbox-text';
import type { Inbox } from '@/lib/crm/inbox';
import type { MenuButton } from '@/lib/roles/chat-menu';

export const OPERATOR_REPLY_ROWS: ReadonlyArray<ReadonlyArray<string>> = [
  ['Новые заявки', 'Мои туры и цены'],
  ['Обновить места', 'Помощь'],
];

export const OPERATOR_COMMANDS: ReadonlyArray<{ command: string; description: string }> = [
  { command: 'requests', description: 'Новые заявки' },
  { command: 'tours', description: 'Мои туры и цены' },
  { command: 'seats', description: 'Обновить места' },
  { command: 'help', description: 'Помощь' },
];

export function operatorReplyMarkup(): {
  keyboard: Array<Array<{ text: string }>>;
  resize_keyboard: boolean;
  is_persistent: boolean;
} {
  return {
    keyboard: OPERATOR_REPLY_ROWS.map((row) => row.map((text) => ({ text }))),
    resize_keyboard: true,
    is_persistent: true,
  };
}

export function operatorBoundText(name: string): string {
  const who = escapeHtml(name);
  return [
    `Вы подключены как туроператор «${who}».`,
    'Сюда будут приходить заявки: новые брони и запросы, которые ждут ответа.',
    'Имя и телефон туриста в этот чат не приходят — их принимает MAX.',
    '',
    'Дальше, кнопки внизу:',
    '«Новые заявки» — что ждёт ответа, с кнопками карточки.',
    '«Мои туры и цены» — живые туры и цена из каталога.',
    '«Обновить места» — как отметить места на даты.',
    '«Помощь» — справка. Заявка в поддержку создаётся только кнопкой «Написать в поддержку».',
  ].join('\n');
}

export const SUPPORT_BUTTON: MenuButton = { text: 'Написать в поддержку', payload: 'sup:new' };

export function operatorDeskButtons(): MenuButton[][] {
  return [
    [
      { text: 'Новые заявки', payload: 'rm:op:in' },
      { text: 'Мои туры и цены', payload: 'opd:tours' },
    ],
    [
      { text: 'Обновить места', payload: 'opd:seats' },
      { text: 'Помощь', payload: 'rm:op:hp' },
    ],
    [SUPPORT_BUTTON],
  ];
}

export function operatorHelpText(): string {
  return [
    'Кабинет туроператора. Кнопки внизу:',
    '«Новые заявки» и «Мои заявки» — один список: что ждёт ответа.',
    '«Мои туры и цены» — название и цена из каталога, без оценки.',
    '«Обновить места» — где отметить занятость. Само сообщение места не закрывает.',
    '«Помощь» — этот текст.',
    '«Написать в поддержку» — отдельная кнопка. Само слово «Помощь» тикет не создаёт.',
    'Оплата через платформу не принимается. Бронь кнопкой ответа не подтверждается.',
  ].join('\n');
}

export function operatorSeatsText(): string {
  return [
    'Места на даты этим сообщением не меняются.',
    `Откройте календарь: ${calendarLink()}`,
    'В MAX можно написать фразу целиком, например: «открой весь ноябрь, 8 мест» — там есть кнопка подтверждения.',
  ].join('\n');
}

export function operatorToursText(tours: ReadonlyArray<{ title: string; price: string | null; url: string }>): string {
  if (tours.length === 0) {
    return 'В каталоге нет живого тура этой компании. Цену не называю.';
  }
  const lines = ['<b>Мои туры и цены</b>', 'Цена — как в каталоге.'];
  for (const tour of tours) {
    lines.push(`• ${escapeHtml(tour.title)} — ${tour.price ? escapeHtml(tour.price) : 'цена не указана'}`);
    lines.push(escapeHtml(tour.url));
  }
  return lines.join('\n');
}

export function tourPriceLabel(price: number | string | null, unit: string | null): string | null {
  const n = typeof price === 'number' ? price : price ? Number(price) : null;
  if (!n || !Number.isFinite(n) || n <= 0) return null;
  const labeled = priceFromUnit(n, unit);
  return labeled
    ? labeled.replace(' (за что назначена цена — не записано, не называй её ценой с человека)', '')
    : null;
}

const BUTTON_CAP = 2;

/** Список входящих и кнопки карточки на первые две заявки, у которых ответ уже определён. */
export function operatorInboxView(inbox: Inbox): { text: string; buttons: MenuButton[][] } {
  const text = inboxMenuText(inbox);
  const buttons: MenuButton[][] = [];
  let n = 0;
  for (const item of inbox.items) {
    const kind = chatAnswerOfInbox(item.kind);
    if (!kind) continue;
    n += 1;
    if (n > BUTTON_CAP) break;
    const row = chatAnswerButtons(n, kind, item.id);
    buttons.push(row.slice(0, 2), row.slice(2));
  }
  return { text, buttons };
}

export type OperatorTourLine = { title: string; price: string | null; url: string };

/** Живые туры этой компании: тот же шлюз, что у витрины. Черновик в список не входит. */
export async function loadOperatorTours(partnerId: string): Promise<
  { ok: true; tours: OperatorTourLine[] } | { ok: false }
> {
  try {
    const { rows } = await pool.query<{
      id: string;
      title: string;
      slug: string | null;
      base_price: string | null;
      price_unit: string | null;
    }>(
      `SELECT ot.id::text AS id, ot.title, ot.slug, ot.base_price::text AS base_price, ot.price_unit
         FROM operator_tours ot
        WHERE ot.operator_id = $1::uuid
          AND ${publicTourSql('ot')}
        ORDER BY ot.title ASC
        LIMIT 12`,
      [partnerId],
    );
    const base = getPublicBaseUrl().replace(/\/$/, '');
    return {
      ok: true,
      tours: rows.map((row) => ({
        title: row.title,
        price: tourPriceLabel(row.base_price, row.price_unit),
        url: `${base}${tourPath({ id: row.id, slug: row.slug })}`,
      })),
    };
  } catch (err) {
    console.error('[operator-desk] туры не прочитаны, SQLSTATE', (err as { code?: string }).code ?? 'нет SQLSTATE');
    return { ok: false };
  }
}

export function operatorToursReply(loaded: { ok: true; tours: OperatorTourLine[] } | { ok: false }): string {
  if (!loaded.ok) return 'Не удалось прочитать туры. Цену не называю.';
  return operatorToursText(loaded.tours);
}
