/**
 * Текст в личном диалоге, который не чат карточки, — возможно, чат менеджера
 * команды оператора (lib/operators/member-chat, слово владельца 30.10
 * «менеджеры оператора»). Общий вход MAX и Telegram: вебхук только доставляет.
 *
 *  - слово меню или команда («Входящие», /tasks, /start…) — раздел его
 *    кабинета в чате (`memberCabinetSectionOf`);
 *  - в MAX после «Найти клиента» следующее сообщение — запрос поиска.
 *    Ожидание спрашивается у базы, только когда текст не команда: без этого
 *    запрос менеджера ушёл бы Кузьмичу туриста, а подсказка поиска обещала,
 *    что текст поиска уходит только в CRM. В Telegram поиска нет вовсе;
 *  - прочий текст и чат не менеджера — false: сообщение идёт своим путём,
 *    как раньше;
 *  - «не смог проверить, чей чат» — ответ словами, а не Кузьмич туриста (§4.0).
 *
 * Беда в тексте — блок 112 отдельным сообщением перед экраном (его правкой
 * стёрла бы первая кнопка); вызывающий отдаёт `userText` своей доставке.
 */

import { findMemberByChat } from '@/lib/operators/member-chat';
import { withSosBlock } from '@/lib/safety/sos-detector';
import type { CabinetChannel, CabinetScreen } from '@/lib/chat-cabinet/screens';
import {
  awaitsCabinetSearch, cabinetSectionFor, captureCabinetSearch, memberCabinetSectionOf,
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
  const trimmed = input.text.trim();
  const searching = section === null && input.channel === 'max' && trimmed !== '' && !trimmed.startsWith('/')
    && await awaitsCabinetSearch(input.chatId);
  if (section === null && !searching) return false;
  const member = await findMemberByChat(input.channel, input.chatId);
  if (member.outcome === 'none') return false;
  if (member.outcome === 'unavailable') {
    await deliver.say(withSosBlock(MEMBER_UNCHECKED, input.text).text);
    return true;
  }
  const nowMs = input.nowMs ?? Date.now();
  if (section !== null) {
    await deliver.show(await cabinetSectionFor(member.member.partner, input.channel, section, nowMs, 'member'), input.text);
    return true;
  }
  const found = await captureCabinetSearch({
    chatId: input.chatId, partner: member.member.partner, text: input.text, seat: 'member', nowMs,
  });
  if (!found) return false;
  await deliver.show(found, input.text);
  return true;
}
