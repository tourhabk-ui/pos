/**
 * Письмо с данными выезда для МЧС — пока тест.
 *
 * Слово владельца 10.11: «api мчс нет или нам не дают форма сложная можем
 * попробывать пока письмом на flo@vedarai.ru потом после тестов свяжусь с
 * МЧС». Оператор и гид из кабинета в чате отправляют данные выезда письмом.
 *
 * ── Что письмо есть и чем оно не является ──────────────────────────────────
 *
 * Получатель — ящик Ведара (`MCHS_LETTER.to`), НЕ МЧС. Письмо в ведомство не
 * уходит, заявкой не является, и чат обязан говорить это словами на каждом
 * экране: «отправлено» без «куда» человек прочитает как «подано в МЧС» и
 * форму МЧС уже не откроет (§0, §4.0). Заявку по-прежнему подаёт руководитель
 * группы — кнопка «Открыть форму МЧС» остаётся на всех экранах.
 *
 * Получатель и признак теста — константы в коде, не env: перевод на адрес
 * МЧС — видимый коммит вместе с текстами экранов, согласием на передачу ПД и
 * словом владельца после его разговора с МЧС. Сторож
 * (tests/unit/mchs-letter.test.ts) держит связку: пока `test: true`,
 * получатель — адрес на vedarai.ru, а тексты называют письмо тестовым.
 *
 * В письме — имя и телефон контактного лица каждой брони (ПД туристов).
 * В чат они отсюда не возвращаются: ответ кабинета после отправки ПД не несёт.
 * В журнал (`mchs_letters`, 1415) пишется только счёт людей и броней.
 */

import { escapeHtml, safeSubject } from '@/lib/text/escape-html';
import { MCHS_ONLINE_FORM_URL } from '@/lib/safety/mchs-registration';
import { mchsGroupText, type MchsGroup } from '@/lib/safety/mchs-chat';

/** Куда уходит письмо. `test: true` — ящик Ведара, в МЧС письмо не отправляется. */
export const MCHS_LETTER = { to: 'flo@vedarai.ru', test: true } as const;

/** Повтор по тому же выезду раньше этого срока не отправляется (двойное нажатие). */
export const MCHS_LETTER_REPEAT_MS = 10 * 60_000;

export type MchsLetterOutcome = 'sent' | 'failed' | 'not_configured';

/** Кто отправляет: карточка партнёра и её роль словом. */
export interface MchsLetterSender {
  partnerId: string;
  partnerName: string;
  role: 'operator' | 'guide';
  channel: 'max' | 'telegram';
}

const ROLE_WORD: Readonly<Record<MchsLetterSender['role'], string>> = { operator: 'туроператор', guide: 'гид' };

function ruDate(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : ymd;
}

/** Шапка письма: что это тест и что в МЧС оно не уходило. */
export const MCHS_LETTER_TEST_BANNER =
  'ТЕСТОВОЕ ПИСЬМО Ведара. В МЧС не отправлялось и заявкой на регистрацию группы не является.';

export function mchsLetterSubject(g: MchsGroup): string {
  const mark = MCHS_LETTER.test ? '[ТЕСТ] ' : '';
  return safeSubject(`${mark}Регистрация туристской группы: ${g.title}, ${ruDate(g.date)} — ${ruDate(g.endDate)}`);
}

/**
 * Тело письма (HTML). Текст выезда — тот же, что видит оператор в чате
 * (`mchsGroupText`, всё введённое людьми уже экранировано).
 */
export function mchsLetterHtml(g: MchsGroup, sender: MchsLetterSender, nowMs: number): string {
  const lines: string[] = [];
  if (MCHS_LETTER.test) lines.push(`<p><b>${MCHS_LETTER_TEST_BANNER}</b></p>`);
  lines.push(`<p>Отправил: ${escapeHtml(sender.partnerName)} (${ROLE_WORD[sender.role]}) из кабинета Ведара в чате.</p>`);
  lines.push(`<p>${mchsGroupText(g, nowMs, { allContacts: true }).replace(/\n/g, '<br>')}</p>`);
  lines.push(`<p>Официальная форма МЧС: <a href="${MCHS_ONLINE_FORM_URL}">${MCHS_ONLINE_FORM_URL}</a></p>`);
  return lines.join('\n');
}

/** Слова кабинета в чате о письме. Все называют, куда оно ушло и чем не является. */
export const MCHS_LETTER_TEXT = {
  button: 'Отправить письмом (тест)',
  yes: 'Да, отправить',
  askHead: '<b>Отправить данные выезда письмом?</b>',
  askWhere: 'Это проверка: письмо уйдёт на тестовый ящик Ведара, не в МЧС. Заявкой в МЧС оно не станет — её по-прежнему подаёте вы в форме МЧС.',
  askWhat: 'В письме: даты, маршрут, число людей и контактные лица броней — имя и телефон.',
  sent: 'Письмо с данными выезда принято почтовым сервером и ушло на тестовый ящик Ведара. В МЧС оно не отправлено: заявку подаёте вы — кнопка «Открыть форму МЧС».',
  sentNotLogged: 'Отметка об отправке в журнал не записалась — повторное нажатие может отправить письмо ещё раз.',
  notConfigured: 'Почта на сервере не настроена — письмо не ушло. Данные выезда можно перенести в форму МЧС самим.',
  failed: (reason: string): string => `Письмо не ушло: ${escapeHtml(reason)}. Ничего не отправлено — данные выезда можно перенести в форму МЧС самим.`,
  recent: (at: string | null): string =>
    `Письмо по этому выезду уже ушло на тестовый ящик Ведара${at ? ` ${at} по Камчатке` : ''}. Повторно — не раньше чем через ${Math.round(MCHS_LETTER_REPEAT_MS / 60_000)} минут. В МЧС оно не отправлено.`,
  unchecked: 'Не удалось проверить, отправлялось ли уже письмо по этому выезду, — не отправляю, чтобы не задвоить. Попробуйте позже.',
  ownerOnly: 'Письмо с данными выезда отправляет владелец кабинета — в своём чате. Ничего не отправил.',
  last: (at: string | null): string =>
    `Письмо (тест) по этому выезду уже уходило на ящик Ведара${at ? ` ${at} по Камчатке` : ''}. В МЧС — нет.`,
  lastUnchecked: 'Отправлялось ли письмо по этому выезду, сейчас не прочиталось.',
} as const;
