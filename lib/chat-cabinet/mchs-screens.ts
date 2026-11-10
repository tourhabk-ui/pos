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
  if (args.departures === null) return build([MCHS_CHAT_TEXT.listHead, MCHS_CHAT_TEXT.listFailed], [[FORM_BUTTON]], false, true);
  if (args.departures.length === 0) {
    return build([MCHS_CHAT_TEXT.listHead, MCHS_CHAT_TEXT.listRule, '', MCHS_CHAT_TEXT.listEmpty], [[FORM_BUTTON]]);
  }
  const shown = args.departures.slice(0, MCHS_LIST_MAX);
  const lines = [MCHS_CHAT_TEXT.listHead, MCHS_CHAT_TEXT.listRule, ''];
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
}): CabinetScreen {
  const withContacts = args.group.contacts !== null;
  const lines = [MCHS_CHAT_TEXT.groupHead, '', mchsGroupText(args.group, args.nowMs)];
  const rows: CabinetButton[][] = [[FORM_BUTTON]];
  if (!withContacts) {
    lines.push(MCHS_CHAT_TEXT.groupNoContactsTelegram);
    rows.push([{ text: 'Кабинет на сайте', url: siteUrl(args.base, args.role) }]);
  }
  rows.push([{ text: `‹ ${MCHS_CHAT_BUTTON}`, payload: cabinetPayload.mchs() }]);
  return build(lines, rows, withContacts);
}
