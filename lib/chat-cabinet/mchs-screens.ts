/**
 * Экраны «Регистрации в МЧС» кабинета в чате (10.11) — тексты и кнопки, без
 * базы. Правила и слова — lib/safety/mchs-chat, чтение — mchs-store.
 *
 * Экран выезда с контактами туристов помечен `pd: true`: вызывающий в
 * Telegram его не отдаёт (второй замок сервиса, lockForChannel). Для Telegram
 * сервис просит выезд без контактов — тогда `pd: false` и имён в тексте нет.
 */

import { cabinetPayload } from '@/lib/chat-cabinet/payload';
import { cabinetNavRows, siteUrl, type CabinetButton, type CabinetRole, type CabinetScreen } from '@/lib/chat-cabinet/screens';
import {
  MCHS_CHAT_BUTTON, MCHS_CHAT_TEXT, MCHS_LIST_MAX, mchsDepartureLines, mchsGroupText,
  type MchsDeparture, type MchsGroup,
} from '@/lib/safety/mchs-chat';
import { MCHS_ONLINE_FORM_URL } from '@/lib/safety/mchs-registration';
import { MCHS_LETTER_TEXT } from '@/lib/safety/mchs-letter-text';

const BUTTON_TEXT_MAX = 40;

function clip(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > BUTTON_TEXT_MAX ? `${t.slice(0, BUTTON_TEXT_MAX - 1).trimEnd()}…` : t;
}

function dayMonth(ymd: string): string {
  return `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}`;
}

const FORM_BUTTON: CabinetButton = { text: 'Открыть форму МЧС', url: MCHS_ONLINE_FORM_URL };

function build(lines: string[], rows: CabinetButton[][], pd = false, failed = false): CabinetScreen {
  const screen: CabinetScreen = { text: lines.join('\n'), rows: [...rows, ...cabinetNavRows()], pd };
  if (failed) screen.failed = true;
  return screen;
}

/** Список выездов: срок по каждому и кнопка «собрать данные». `null` — база не ответила. */
export function mchsListScreen(args: { departures: MchsDeparture[] | null; nowMs: number }): CabinetScreen {
  const head = [MCHS_CHAT_TEXT.listHead, MCHS_CHAT_TEXT.afterReturn];
  if (args.departures === null) return build([...head, MCHS_CHAT_TEXT.listFailed], [[FORM_BUTTON]], false, true);
  if (args.departures.length === 0) {
    return build([...head, MCHS_CHAT_TEXT.listRule, '', MCHS_CHAT_TEXT.listEmpty], [[FORM_BUTTON]]);
  }
  const shown = args.departures.slice(0, MCHS_LIST_MAX);
  const lines = [...head, MCHS_CHAT_TEXT.listRule, ''];
  for (const d of shown) lines.push(...mchsDepartureLines(d, args.nowMs), '');
  if (args.departures.length > shown.length) {
    lines.push(`Показаны ближайшие ${shown.length} из ${args.departures.length} — остальные в кабинете на сайте.`);
  }
  const rows: CabinetButton[][] = shown.map((d) => [{
    text: clip(`${dayMonth(d.date)} · ${d.title}`),
    payload: cabinetPayload.mchsGroup(d.tourId, d.date),
  }]);
  rows.push([FORM_BUTTON]);
  return build(lines, rows);
}

/** Выезд: данные одним текстом для формы МЧС. */
export function mchsGroupScreen(args: {
  group: MchsGroup; role: CabinetRole; base: string; nowMs: number;
  /** Показать «Отправить письмом»: только владельцу кабинета. */
  canSend?: boolean;
  /** Строка о прошлом письме по этому выезду (или о том, что журнал не прочитался). */
  letterLine?: string | null;
}): CabinetScreen {
  const withContacts = args.group.contacts !== null;
  // Шапка велит скопировать текст до черты. Всё, что ниже черты, — слова
  // Ведара, и в заявку они попасть не должны: пояснение об именах (оно стоит
  // сразу под текстом, который объясняет), строка о возвращении, строка о письме.
  const lines = [MCHS_CHAT_TEXT.groupHead, '', mchsGroupText(args.group, args.nowMs), MCHS_CHAT_TEXT.groupRule];
  const rows: CabinetButton[][] = [[FORM_BUTTON]];
  if (!withContacts) {
    lines.push(MCHS_CHAT_TEXT.groupNoContactsTelegram, '');
    rows.push([{ text: 'Кабинет на сайте', url: siteUrl(args.base, args.role) }]);
  }
  lines.push(MCHS_CHAT_TEXT.afterReturn);
  if (args.letterLine) lines.push('', args.letterLine);
  if (args.canSend) {
    rows.push([{ text: MCHS_LETTER_TEXT.button, payload: cabinetPayload.mchsLetterAsk(args.group.tourId, args.group.date) }]);
  }
  rows.push([{ text: `‹ ${MCHS_CHAT_BUTTON}`, payload: cabinetPayload.mchs() }]);
  return build(lines, rows, withContacts);
}

/** «Отправить письмом?» — куда уйдёт и что в нём. Имён на экране нет. */
export function mchsLetterAskScreen(args: { group: MchsGroup; nowMs: number }): CabinetScreen {
  const g = args.group;
  return build([
    MCHS_LETTER_TEXT.askHead,
    mchsDepartureLines(g, args.nowMs)[0]!,
    '',
    MCHS_LETTER_TEXT.askWhere,
    MCHS_LETTER_TEXT.askWhat,
  ], [
    [{ text: MCHS_LETTER_TEXT.yes, payload: cabinetPayload.mchsLetterSend(g.tourId, g.date), intent: 'positive' }],
    [{ text: '‹ Назад', payload: cabinetPayload.mchsGroup(g.tourId, g.date) }],
  ]);
}

/** Итог отправки (или отказ): текст, форма МЧС и возврат к выезду. Без ПД. */
export function mchsLetterResultScreen(args: { text: string; tourId: string; date: string; failed?: boolean }): CabinetScreen {
  return build(
    [`<b>${MCHS_CHAT_BUTTON}</b>`, args.text],
    [[FORM_BUTTON], [{ text: '‹ К выезду', payload: cabinetPayload.mchsGroup(args.tourId, args.date) }]],
    false, args.failed === true,
  );
}
