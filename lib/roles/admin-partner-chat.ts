/**
 * Чат администратора, который ещё и чат карточки партнёра.
 *
 * Владелец проверяет кабинет оператора из своего MAX или Telegram: привязал
 * себя администратором (adm_, adt_) и тестового оператора (op_) к одному
 * чату. Консоль администратора стоит раньше кабинета партнёра — и забирала
 * всё: «Следующая заявка» с кнопки запроса мест читалась по подстроке
 * «заявк» как «Заявки» администратора (все заявки платформы), «Сводка» —
 * как сводка суток, а «Входящие» и «кто ждёт ответа?» получали «Не понял
 * команду» (проверка каналов 25.10).
 *
 * Правило: консоль берёт только то, что понимает сама. Команда кабинета
 * партнёра своей формой (кнопки запроса мест и меню роли, кабинет проката) и
 * всё, чего консоль не понимает, уходят кабинету партнёра. Кнопки
 * администратора (rm:ad:) идут своим путём и этим не затронуты.
 *
 * Пока кабинет гида ждёт причину отклонения брони (после кнопки «Отклонить»,
 * lib/bookings/chat-owner-action), любое сообщение этого чата — кабинету:
 * иначе причина со словом команды консоли («брони перенесли») ушла бы консоли,
 * а гид не получил бы вопроса «Да / Не надо». Так же — пока кабинет в чате
 * MAX ждёт запрос поиска клиента (кнопка «Найти клиента», lib/chat-cabinet).
 */

import { findPartnerByChat } from '@/lib/kuzmich/operator-chat';
import { chatActionsEnabledFor } from '@/lib/bookings/chat-owner-press';
import { adminCommandOf } from '@/lib/max/admin-read';
import { rentalCabinetAsk } from '@/lib/rental/cabinet-bar';
import { roleMenuAsk, type MenuPartner } from '@/lib/roles/role-menu';
import { guideKeyboardAction } from '@/lib/telegram/guide-desk';
import { isNextCommand } from '@/lib/seat-requests/answer-edit';
import { isSummaryCommand, summaryEnabledFor } from '@/lib/seat-requests/summary';

/** Команда кабинета партнёра своей формой — та, что шлют его кнопки. */
function partnerCabinetCommand(channel: 'telegram' | 'max', text: string, partner: MenuPartner): boolean {
  if (isSummaryCommand(text) && summaryEnabledFor(partner.partnerId)) return true;
  // Кнопка постоянной клавиатуры гида (она есть только в Telegram): «Брони»
  // иначе забрала бы консоль по слову «брон».
  if (channel === 'telegram' && guideKeyboardAction(text, partner) !== null) return true;
  if (isNextCommand(text)) return true;
  const ask = roleMenuAsk(text);
  // «Помощь» понимают оба; у администратора она своя, кнопка партнёра «Помощь» — его меню.
  if (ask !== null && ask !== 'help') return true;
  return rentalCabinetAsk(text) !== null;
}

/**
 * Администратор, который ещё и менеджер команды оператора (владелец Ведара в
 * пилоте с «Местечком»): консоль уступает его кабинету в чате слова разделов
 * и запрос поиска клиента — иначе «Бронникова» после «Найти клиента» ушла бы
 * консоли по «брон». Прочее остаётся консоли, как раньше. Не прочиталось —
 * консоль работает как раньше.
 */
async function yieldsToMember(channel: 'telegram' | 'max', chatId: number, text: string): Promise<boolean> {
  const ask = roleMenuAsk(text);
  const sectionWord = ask === 'inbox' || ask === 'tasks' || ask === 'clients';
  let searching = false;
  if (!sectionWord && channel === 'max') {
    const { awaitsCabinetSearch } = await import('@/lib/chat-cabinet/service');
    searching = await awaitsCabinetSearch(chatId);
  }
  if (!sectionWord && !searching) return false;
  const { findMemberByChat } = await import('@/lib/operators/member-chat');
  return (await findMemberByChat(channel, chatId)).outcome === 'found';
}

/**
 * true — текст в этом чате отдаётся кабинету партнёра, а не консоли
 * администратора. Чат не привязан к карточке или база не ответила — false:
 * консоль работает как раньше.
 */
export async function adminChatYieldsToPartner(
  channel: 'telegram' | 'max',
  chatId: number,
  text: string,
): Promise<boolean> {
  const lookup = await findPartnerByChat(channel, chatId);
  if (lookup.outcome === 'none') return yieldsToMember(channel, chatId, text);
  if (lookup.outcome !== 'found') return false;
  if (chatActionsEnabledFor(lookup.partner)) {
    const { awaitsOwnerReason } = await import('@/lib/bookings/chat-owner-action');
    if (await awaitsOwnerReason(channel, chatId)) return true;
  }
  // Поиск клиента кабинета в чате (только MAX): запрос «Бронникова» иначе
  // забрала бы консоль по слову «брон».
  if (channel === 'max') {
    const { awaitsCabinetSearch } = await import('@/lib/chat-cabinet/service');
    if (await awaitsCabinetSearch(chatId)) return true;
  }
  if (partnerCabinetCommand(channel, text, lookup.partner)) return true;
  return adminCommandOf(text) === null;
}
