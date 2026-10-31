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
import { ownerToursUrl } from '@/lib/partners/cabinet-links';
import { kamchatkaDate } from '@/lib/analytics/kamchatka-day';
import { telegramSeatsText } from '@/lib/operators/chat-dates/texts';
import type { MenuButton } from '@/lib/roles/chat-menu';

export const OPERATOR_REPLY_ROWS: ReadonlyArray<ReadonlyArray<string>> = [
  ['Новые заявки', 'Мои туры и цены'],
  ['Задачи', 'Клиенты'],
  ['Обновить места', 'Помощь'],
];

export const OPERATOR_COMMANDS: ReadonlyArray<{ command: string; description: string }> = [
  { command: 'requests', description: 'Новые заявки' },
  { command: 'tasks', description: 'Задачи' },
  { command: 'clients', description: 'Клиенты' },
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

export function operatorBoundText(name: string, channel: 'telegram' | 'max' = 'telegram'): string {
  const who = escapeHtml(name);
  const contacts = channel === 'max'
    ? 'Имя и телефон туриста приходят в этот чат.'
    : 'Имя и телефон туриста в этот чат не приходят — их принимает MAX.';
  return [
    `Вы подключены как туроператор «${who}».`,
    'Сюда будут приходить заявки: новые брони и запросы, которые ждут ответа.',
    contacts,
    '',
    'Дальше, кнопки внизу:',
    '«Новые заявки» — что ждёт ответа: номер в списке открывает карточку с кнопками ответа.',
    '«Задачи» и «Клиенты» — задачи и клиенты вашей CRM. Имена и телефоны клиентов — только в MAX.',
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
      { text: 'Задачи', payload: 'rm:op:tk' },
      { text: 'Клиенты', payload: 'rm:op:cl' },
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
    '«Новые заявки» и «Мои заявки» — один список: что ждёт ответа. Номер в списке открывает карточку.',
    '«Задачи» — открытые задачи по сроку: «Готово» и «На завтра». «Клиенты» — клиенты CRM и поиск. '
      + 'Имена, телефоны и заголовки задач — только в MAX.',
    '«Мои туры и цены» — название и цена из каталога, без оценки.',
    '«Обновить места» — открыть даты: в MAX — кнопками (тур, месяц, дни, места) или фразой, даты меняются только '
      + 'после кнопки «Открыть»; в Telegram — в календаре кабинета.',
    'В карточке брони — «Подтвердить» и «Отклонить»: бот спросит, и бронь меняется только после «Да». '
      + 'Нажимает тот, кто подключил этот чат ссылкой из кабинета.',
    'В карточке заявки — «Принять», «Нет мест», «Уточнить», «Свяжусь сам». Бронь кнопкой ответа на заявку не подтверждается.',
    'Утром, если что-то ждёт ответа или подошёл срок задачи, бот пришлёт короткую сводку.',
    '«Помощь» — этот текст.',
    '«Написать в поддержку» — отдельная кнопка. Само слово «Помощь» тикет не создаёт.',
    'Оплата через платформу не принимается.',
  ].join('\n');
}

/**
 * «Обновить места» в Telegram — где открыть даты. Туроператору — календарь,
 * гиду со своими турами — раздел «Свои туры» (кабинет оператора его не
 * пустит); и MAX, где даты открываются кнопками или фразой с кнопкой
 * подтверждения (lib/operators/chat-dates). В MAX этого текста нет: там
 * «Обновить места» начинает даты кнопками (wizard-flow).
 */
export function operatorSeatsText(category: string | null = 'operator', nowMs: number = Date.now()): string {
  return telegramSeatsText(category === 'guide' ? 'guide' : 'operator', kamchatkaDate(new Date(nowMs)));
}

/**
 * Пустой список — не тупик (снимок владельца 31.10: «В каталоге нет живого
 * тура этой компании. Цену не называю.» — и дальше ничего): называем, почему
 * туристы не видят ни одного тура, и куда идти. Видит тур тот, кто включён и
 * опубликован (`publicTourSql`); черновик и выключенный — нет.
 */
export function operatorToursText(tours: ReadonlyArray<{ title: string; price: string | null; url: string }>): string {
  if (tours.length === 0) {
    return [
      'Туристы пока не видят ни одного вашего тура: в каталоге только опубликованные и включённые.',
      `Добавить тур или опубликовать черновик — в кабинете: ${ownerToursUrl('operator')}`,
    ].join('\n');
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
  if (!loaded.ok) return `Не смог прочитать ваши туры — попробуйте через минуту. Список есть и в кабинете: ${ownerToursUrl('operator')}`;
  return operatorToursText(loaded.tours);
}
