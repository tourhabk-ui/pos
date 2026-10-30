/**
 * Текст в личном диалоге, который не чат карточки, — возможно, чат менеджера
 * команды оператора (lib/operators/member-chat, слово владельца 30.10
 * «менеджеры оператора»). Общий вход MAX и Telegram: вебхук только доставляет.
 *
 *  - слово меню или команда («Входящие», /tasks, /start…) — раздел его
 *    кабинета в чате (`memberCabinetSectionOf`). Не прочиталось, менеджер ли
 *    это, — сообщение идёт своим путём, как раньше: «/start» туриста не должен
 *    получать «не смог проверить», а в «Входящие» менеджера ПД нет;
 *  - в MAX после «Найти клиента» следующее сообщение — запрос поиска.
 *    Ожидание спрашивается у базы, только когда текст не команда. Здесь
 *    отказ проверки — не «не ждёт» (ревью 30.10): сообщение менеджера могло
 *    быть запросом с фамилией, а подсказка обещала, что текст поиска уходит
 *    только в CRM. Поэтому не прочиталось ожидание или менеджер — ответ
 *    словами, а не Кузьмич туриста; поиск ждал, а менеджера уже сняли —
 *    поиск гасится, сообщение тоже никуда не уходит. Беда и контроль выхода
 *    идут своим путём при любом исходе. В Telegram поиска нет вовсе;
 *  - прочий текст и чат не менеджера — false: сообщение идёт своим путём.
 *
 * Беда в тексте — блок 112 отдельным сообщением перед экраном (его правкой
 * стёрла бы первая кнопка); вызывающий отдаёт `userText` своей доставке.
 */

import { findMemberByChat } from '@/lib/operators/member-chat';
import { detectEmergency, withSosBlock } from '@/lib/safety/sos-detector';
import { isWatchTrigger } from '@/lib/kuzmich/watch-flow';
import { CABINET_TEXT, type CabinetChannel, type CabinetScreen } from '@/lib/chat-cabinet/screens';
import {
  cabinetSearchWaiting, cabinetSectionFor, captureCabinetSearch, dropCabinetSearch, memberCabinetSectionOf,
} from '@/lib/chat-cabinet/service';

export const MEMBER_UNCHECKED = 'Не удалось проверить, чей это чат. Ничего не открыл — попробуйте ещё раз.';

export async function memberCabinetText(
  input: { channel: CabinetChannel; chatId: number; text: string; nowMs?: number },
  deliver: {
    /** Экран кабинета новым сообщением; `userText` — для блока 112. */
    show: (screen: CabinetScreen, userText: string) => Promise<void>;
    /** Короткий ответ без экрана. */
    say: (text: string) => Promise<void>;
  },
): Promise<boolean> {
  const section = memberCabinetSectionOf(input.text);
  const nowMs = input.nowMs ?? Date.now();
  if (section !== null) {
    const member = await findMemberByChat(input.channel, input.chatId);
    if (member.outcome === 'none' || member.outcome === 'unavailable') return false;
    if (member.outcome === 'ambiguous') {
      await deliver.say(withSosBlock(CABINET_TEXT.memberTwoTeams, input.text).text);
      return true;
    }
    await deliver.show(await cabinetSectionFor(member.member.partner, input.channel, section, nowMs, 'member'), input.text);
    return true;
  }

  const trimmed = input.text.trim();
  if (input.channel !== 'max' || trimmed === '' || trimmed.startsWith('/')) return false;
  const waiting = await cabinetSearchWaiting(input.chatId);
  if (waiting === false) return false;
  // Беда и контроль выхода — своим путём при любом исходе ниже.
  const urgent = detectEmergency(input.text).detected || isWatchTrigger(input.text);
  const member = await findMemberByChat(input.channel, input.chatId);
  if (member.outcome === 'none') {
    if (waiting === null || urgent) return false; // не менеджер — турист или незнакомый чат
    // Поиск ждал, а чат больше не чат менеджера (сняли): запрос никуда не уходит.
    await dropCabinetSearch(input.chatId);
    await deliver.say(CABINET_TEXT.searchGone);
    return true;
  }
  if (urgent) return false;
  if (member.outcome === 'unavailable') {
    // Не известно ни ожидание, ни чей чат — база лежит: туристу его
    // сообщение не задерживаем. Ожидание точно есть — чат кабинетный, и
    // запрос дальше не отдаём.
    if (waiting === null) return false;
    await deliver.say(MEMBER_UNCHECKED);
    return true;
  }
  if (member.outcome === 'ambiguous') {
    await deliver.say(CABINET_TEXT.memberTwoTeams);
    return true;
  }
  if (waiting === null) {
    await deliver.say(CABINET_TEXT.searchUnchecked);
    return true;
  }
  const found = await captureCabinetSearch({
    chatId: input.chatId, partner: member.member.partner, text: input.text, seat: 'member', nowMs,
  });
  if (!found) return false;
  await deliver.show(found, input.text);
  return true;
}
