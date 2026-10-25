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
 */

import { findPartnerByChat } from '@/lib/kuzmich/operator-chat';
import { adminCommandOf } from '@/lib/max/admin-read';
import { rentalCabinetAsk } from '@/lib/rental/cabinet-bar';
import { roleMenuAsk } from '@/lib/roles/role-menu';
import { isNextCommand } from '@/lib/seat-requests/answer-edit';
import { isSummaryCommand, summaryEnabledFor } from '@/lib/seat-requests/summary';

/** Команда кабинета партнёра своей формой — та, что шлют его кнопки. */
function partnerCabinetCommand(text: string, partnerId: string): boolean {
  if (isSummaryCommand(text) && summaryEnabledFor(partnerId)) return true;
  if (isNextCommand(text)) return true;
  const ask = roleMenuAsk(text);
  // «Помощь» понимают оба; у администратора она своя, кнопка партнёра «Помощь» — его меню.
  if (ask !== null && ask !== 'help') return true;
  return rentalCabinetAsk(text) !== null;
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
  if (lookup.outcome !== 'found') return false;
  if (partnerCabinetCommand(text, lookup.partner.partnerId)) return true;
  return adminCommandOf(text) === null;
}
