/**
 * Telegram Welcome Messages
 *
 * Персональное приветствие при первом подключении Telegram-канала.
 * Каждая роль получает своё сообщение с объяснением что бот будет делать.
 *
 * Вызывается:
 *   1. После TG Login Widget (app/api/auth/telegram/route.ts)
 *   2. После привязки через deep link /start link_{token} (webhook)
 *
 * Обещать можно только то, что придёт (§10.09, 29.10). Оператору и гиду до
 * этого дня обещались «бронирования с кнопками Подтвердить / Отклонить» и
 * «лиды с контактами туристов»: кнопок в Telegram нет (ловец confirm_/cancel_
 * снят), а имя и телефон туриста по закону о ПД в Telegram не уходят —
 * только в MAX (lib/notifications/pd-alert). Гиду ссылка вела в кабинет
 * оператора, куда его не пускают.
 */

import { telegramService } from '@/lib/notifications/telegram';
import { query } from '@/lib/database';
import { platformAcceptsPayments } from '@/lib/payments/accepting';
import { ROLE_HUB } from '@/lib/auth/role-routes';
import { logSwallowedFailure } from '@/lib/observability/swallowed';

export interface WelcomeContext {
  telegramId: number;
  name: string;
  role: string;
  isNewUser: boolean;
}

export interface UserStats {
  bookings?: number;
  tours?: number;
}

async function getUserStats(userId: string, role: string): Promise<UserStats> {
  try {
    if (role === 'tourist') {
      const res = await query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM operator_bookings WHERE user_id = $1 AND booking_status != 'cancelled' AND deleted_at IS NULL`,
        [userId]
      );
      return { bookings: parseInt(res.rows[0]?.cnt ?? '0') };
    }
    if (role === 'operator' || role === 'guide') {
      const res = await query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM operator_tours ot
         JOIN partners p ON p.user_id = $1 WHERE ot.operator_id = p.id AND ot.is_active = TRUE`,
        [userId]
      );
      return { tours: parseInt(res.rows[0]?.cnt ?? '0') };
    }
  } catch (err) {
    // Без счёта приветствие уходит без строки о числе — это не выдумка.
    logSwallowedFailure('telegram-welcome', 'счёт для приветствия', err);
  }
  return {};
}

/** Текст приветствия — отдельно от отправки, чтобы его судил вызов. */
export function buildWelcomeText(ctx: WelcomeContext, stats: UserStats): string {
  const name = ctx.name.split(' ')[0]; // только имя
  const site = 'https://vedarai.ru';

  if (ctx.role === 'tourist') {
    const bookingLine = stats.bookings && stats.bookings > 0
      ? `\nТвоих активных заявок: <b>${stats.bookings}</b>`
      : '';
    return [
      `<b>Привет, ${name}!</b>`,
      '',
      'Я — Кузьмич, твой личный проводник по Камчатке.',
      'Теперь у нас есть прямой канал.',
      bookingLine,
      '',
      '<b>Что я буду делать для тебя:</b>',
      '— подтверждения и статусы заявок в реальном времени',
      '— напоминание за 2 дня до поездки с погодой',
      '— горячие предложения под твои интересы',
      '— отвечу на любой вопрос о Камчатке',
      '',
      `<a href="${site}/routes">Смотреть маршруты →</a>`,
    ].filter(s => s !== '').join('\n');
  }

  if (ctx.role === 'operator' || ctx.role === 'guide') {
    const toursLine = stats.tours !== undefined
      ? `\nАктивных туров: <b>${stats.tours}</b>`
      : '';
    // Гид продаёт только свои туры (1338); у гида из команды оператора своих
    // броней нет — строка говорит, о каких турах речь.
    const whose = ctx.role === 'guide' ? ' на туры, которые вы продаёте сами' : '';
    return [
      `<b>${name}, личный канал подключён!</b>`,
      '',
      'Отсюда будут приходить:',
      `— новые брони и заявки${whose}: номер, тур, дата и ссылка в кабинет`,
      '— сообщения туристов из чата платформы',
      ...(platformAcceptsPayments() ? ['— еженедельные отчёты по выплатам'] : []),
      '— важные уведомления платформы',
      '',
      'Имя и телефон туриста по закону о персональных данных в Telegram не приходят — они в кабинете и в MAX.',
      'Подтвердить или отклонить бронь — в кабинете.',
      toursLine,
      '',
      `<a href="${site}${ROLE_HUB[ctx.role]}">Открыть кабинет →</a>`,
    ].filter(s => s !== '').join('\n');
  }

  if (ctx.role === 'agent') {
    return [
      `<b>${name}, канал агента подключён!</b>`,
      '',
      'Буду присылать:',
      ...(platformAcceptsPayments() ? ['— комиссионные начисления'] : []),
      '— статусы по рефералам',
      '— новости платформы',
      '',
      `<a href="${site}/hub/agent">Кабинет агента →</a>`,
    ].join('\n');
  }

  if (ctx.role === 'admin') {
    return [
      `<b>${name}, командный центр подключён.</b>`,
      '',
      'Ежедневный дайджест в 09:00.',
      'Инициативы Совета директоров — сюда с кнопками.',
      'SOS-алерты немедленно.',
      '',
      '/stats — статистика сейчас',
      '/digest — полный AI-дайджест',
      '/leads — последние заявки',
    ].join('\n');
  }

  // Fallback
  return `<b>Привет, ${name}!</b>\n\nЛичный канал с Ведаром подключён. Здесь будут важные уведомления.`;
}

/**
 * Отправляет персональное приветствие при первом подключении Telegram.
 * Не блокирует основной поток: отказ не бросается, а пишется в лог.
 */
export async function sendWelcomeMessage(
  userId: string,
  ctx: WelcomeContext,
): Promise<void> {
  try {
    const stats = await getUserStats(userId, ctx.role);
    const text = buildWelcomeText(ctx, stats);

    const res = await telegramService.sendMessage({
      chatId: String(ctx.telegramId),
      text,
      parseMode: 'HTML',
    });
    if (!res.success) console.error(`[telegram-welcome] приветствие (${ctx.role}) не доставлено: ${res.error ?? 'нет ответа'}`);
  } catch (err) {
    // Не блокируем авторизацию, если Telegram недоступен.
    logSwallowedFailure('telegram-welcome', 'приветствие', err);
  }
}
