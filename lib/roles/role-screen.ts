/**
 * Что открывает кнопка меню роли. Чтений новых нет: администратор — те же
 * команды, что словами, партнёр — справка и сводка запросов мест, гид со
 * своими турами — «Брони» и «Мои туры» раздела «Свои туры»
 * (lib/guides/chat-screens). Строку кнопок клеит вызывающий.
 *
 * Вкладки кабинета в чате — «Входящие», «Задачи», «Клиенты», «Ещё»
 * (`isCabinetSection`) — открывает lib/chat-cabinet, а не этот модуль:
 * вызывающий проверяет их раньше и сюда с ними не идёт.
 *
 * Экран с `pd: true` (брони гида в MAX) вызывающий отдаёт только через
 * `sendPdAlert` с `telegramChatId: null`. В Telegram такой экран не строится:
 * канал telegram получает текст без ПД.
 *
 * `buttons` — кнопки действий над строкой меню: у гида со своими турами под
 * «Бронями» — «Подтвердить» и «Отклонить» (lib/bookings/chat-owner-press).
 * Вызывающий ставит их только в личном диалоге: в группе кнопку нажал бы
 * любой участник.
 */

import { guideBookingsScreen, guideToursMenuScreen } from '@/lib/guides/chat-screens';
import {
  adminMenuHelp, guideSellsOwnTours, partnerMenuHelp, type MenuAction, type MenuPartner, type MenuRole,
} from '@/lib/roles/role-menu';
import { adminReplyFor, type AdminReply } from '@/lib/max/admin-read';
import { readSeatSummary, SUMMARY_DB_ERROR, summaryEnabledFor, summaryText } from '@/lib/seat-requests/summary';
import type { MenuButton } from '@/lib/roles/chat-menu';
import type { CabinetSection } from '@/lib/chat-cabinet/service';

export interface RoleScreen {
  text: string;
  /** В тексте контакты туриста. В Telegram такой ответ не отдаём. */
  pd: boolean;
  /** Кнопки действий над строкой меню; нет поля — кнопок нет. */
  buttons?: MenuButton[][];
}

const TELEGRAM_PD = 'Контакты туристов в этом списке есть только в MAX. Здесь их не показываю.';

const SUMMARY_OFF = 'Сводка по запросам мест в этом чате не включена.';

/** Экран с контактами туристов не дошёл до MAX: ответ без ПД и словами. */
export const PARTNER_PD_UNDELIVERED = 'Брони с контактами туристов не доставлены в MAX. Они — в кабинете, раздел «Свои туры».';

/** Устаревшая кнопка у гида, у которого своих туров больше нет. */
export const GUIDE_NO_OWN_TOURS = 'Своих туров в этом кабинете нет. «Брони» и «Мои туры» — для гида, который продаёт туры сам.';

/** Вкладка кабинета в чате: её открывает lib/chat-cabinet, а не roleMenuScreen. */
export function isCabinetSection(action: MenuAction): action is CabinetSection & MenuAction {
  return action === 'inbox' || action === 'tasks' || action === 'clients' || action === 'more';
}

export async function roleMenuScreen(opts: {
  role: MenuRole;
  action: MenuAction;
  channel: 'max' | 'telegram';
  partner: MenuPartner | null;
  nowMs?: number;
}): Promise<RoleScreen> {
  const role = opts.role;
  if (role === 'admin') return adminScreen(opts.action, opts.channel, opts.nowMs);
  if (!opts.partner || opts.partner.category !== role) {
    return { text: 'Эта кнопка — меню другой роли. В этом чате её не выполняю.', pd: false };
  }
  if (opts.action === 'help') {
    return { text: partnerMenuHelp(role, opts.partner), pd: false };
  }
  if (opts.action === 'summary') {
    if (!summaryEnabledFor(opts.partner.partnerId)) return { text: SUMMARY_OFF, pd: false };
    const read = await readSeatSummary(opts.partner.partnerId);
    return { text: read === 'db_error' ? SUMMARY_DB_ERROR : summaryText(read), pd: false };
  }
  if (role === 'guide' && (opts.action === 'bookings' || opts.action === 'tours')) {
    if (!guideSellsOwnTours(opts.partner)) return { text: GUIDE_NO_OWN_TOURS, pd: false };
    if (opts.action === 'tours') return { ...(await guideToursMenuScreen(opts.partner.partnerId)), pd: false };
    const screen = await guideBookingsScreen(opts.partner.partnerId, opts.channel, opts.nowMs ?? Date.now());
    // Второй замок поверх канала экрана: контакт туриста вне MAX не отдаём
    // ни при какой правке chat-screens — как у экрана администратора.
    if (screen.pd && opts.channel !== 'max') return { text: TELEGRAM_PD, pd: false };
    return screen;
  }
  // Вкладки кабинета сюда не приходят (шапка): вызывающий открыл бы их
  // старым экраном без кнопок карточки.
  return { text: 'Такой кнопки в этом кабинете нет.', pd: false };
}

async function adminScreen(action: MenuAction, channel: 'max' | 'telegram', nowMs?: number): Promise<RoleScreen> {
  if (action === 'help') return { text: adminMenuHelp(), pd: false };
  const cmd = action === 'dates' || action === 'bookings' || action === 'leads'
    || action === 'summary' || action === 'health'
    ? action
    : null;
  if (!cmd) return { text: 'Такой кнопки в кабинете администратора нет.', pd: false };
  const reply: AdminReply = await adminReplyFor(cmd, nowMs);
  if (reply.pd && channel !== 'max') return { text: TELEGRAM_PD, pd: false };
  return reply;
}
