/**
 * Что открывает кнопка меню роли. Чтений новых нет: администратор — те же
 * команды, что словами, партнёр — входящие кабинета и сводка запросов мест.
 * Строку кнопок клеит вызывающий.
 */

import { loadInbox } from '@/lib/crm/inbox';
import { adminMenuHelp, partnerMenu, partnerMenuHelp, type MenuAction, type MenuPartner, type MenuRole } from '@/lib/roles/role-menu';
import { inboxMenuText } from '@/lib/roles/inbox-text';
import { adminReplyFor, type AdminReply } from '@/lib/max/admin-read';
import { readSeatSummary, SUMMARY_DB_ERROR, summaryEnabledFor, summaryText } from '@/lib/seat-requests/summary';

export interface RoleScreen {
  text: string;
  /** В тексте контакты туриста. В Telegram такой ответ не отдаём. */
  pd: boolean;
}

const TELEGRAM_PD = 'Контакты туристов в этом списке есть только в MAX. Здесь их не показываю.';

const SUMMARY_OFF = 'Сводка по запросам мест в этом чате не включена.';

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
    const menu = partnerMenu(opts.partner) ?? [];
    return { text: partnerMenuHelp(role, menu), pd: false };
  }
  if (opts.action === 'summary') {
    if (!summaryEnabledFor(opts.partner.partnerId)) return { text: SUMMARY_OFF, pd: false };
    const read = await readSeatSummary(opts.partner.partnerId);
    return { text: read === 'db_error' ? SUMMARY_DB_ERROR : summaryText(read), pd: false };
  }
  if (opts.action !== 'inbox') {
    return { text: 'Такой кнопки в этом кабинете нет.', pd: false };
  }
  const inbox = await loadInbox(opts.partner.partnerId, role, opts.partner.userId ?? null, { nowMs: opts.nowMs });
  return { text: inboxMenuText(inbox), pd: false };
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
