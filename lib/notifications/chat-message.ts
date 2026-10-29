/**
 * lib/notifications/chat-message.ts — уведомление партнёра о новом сообщении
 * в чате турист ↔ оператор/гид.
 *
 * До этого сообщение падало только в базу: партнёр узнавал о нём, лишь зайдя
 * в кабинет сам. CRM-лента (lib/crm/chat-events) фиксирует факт для партнёра
 * внутри платформы, но наружу ничего не отправляла.
 *
 * Канал и правила ПД — те же, что у личных уведомлений о заявках
 * (notifyPartnerNewLeadPersonally в lib/notifications/lead-notify.ts):
 * адрес берётся одним местом — reachForPartner (обе колонки Telegram + MAX),
 * отправка — одной дверью sendPdAlert: полный текст только в MAX, в Telegram
 * при недоступности MAX уходит заглушка без ПД. Старшинство каналов поэтому
 * то же, что у заявок: сначала MAX, потом Telegram-заглушка.
 *
 * Текст сообщения: у заявок комментарий туриста уходит оператору обрезанным
 * до 200 символов — здесь тот же предел и то же место (только MAX-текст;
 * в заглушку ни имя автора, ни текст не попадают).
 *
 * Антиспам без новой схемы: уведомление уходит, только когда это сообщение —
 * ЕДИНСТВЕННОЕ непрочитанное у партнёра в беседе (счёт по
 * conversation_participants.last_read_at после вставки). Серия сообщений
 * подряд даёт одно уведомление; партнёр прочитал беседу (markAsRead) —
 * следующее сообщение уведомляет снова.
 *
 * Хук в `chat.service.sendMessage`: никогда не роняет отправку сообщения,
 * отказ — в лог.
 *
 * Выход без уведомления по правилу (пишет сам партнёр, серия, не текст,
 * беседа не один на один) молчит. Выход, при котором партнёр должен был
 * узнать и не узнает, — роль без чата, нет карточки, не прочитан счёт, —
 * пишет причину в лог (29.10): гид, записанный в беседу «оператором»,
 * уходил отсюда без единой строки, и о сообщениях туристов не знал никто.
 */
import { pool } from '@/lib/db-pool';
import { ROLE_TO_CATEGORY } from '@/lib/crm/partner-context';
import { INBOX_CHAT_CATEGORIES } from '@/lib/crm/inbox-kinds';
import { reachForPartner } from '@/lib/partners/reach';
import { sendPdAlert } from '@/lib/notifications/pd-alert';
import { getPublicBaseUrl } from '@/lib/config';

interface Queryable {
  query: typeof pool.query;
}

function sqlstate(err: unknown): string {
  return (err as { code?: string })?.code ?? 'нет SQLSTATE';
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function notifyPartnerOfChatMessageQuietly(
  conversationId: string,
  senderId: string,
  content: string,
  messageType: string = 'text',
  db: Queryable = pool,
): Promise<void> {
  try {
    if (messageType !== 'text') return;

    const { rows } = await db.query<{ user_id: string; role: string; name: string | null; subject: string | null }>(
      `SELECT cp.user_id, cp.role, u.name, c.subject
         FROM conversation_participants cp
         JOIN users u ON u.id = cp.user_id
         JOIN conversations c ON c.id = cp.conversation_id
        WHERE cp.conversation_id = $1`,
      [conversationId],
    );
    // Уведомление — про беседу один на один, как и лента клиента.
    if (rows.length !== 2) return;
    const partnerSide = rows.find((r) => ROLE_TO_CATEGORY[r.role] !== undefined);
    const touristSide = rows.find((r) => r !== partnerSide);
    if (!partnerSide || !touristSide || partnerSide.user_id === touristSide.user_id) return;

    const category = ROLE_TO_CATEGORY[partnerSide.role];
    // Пишет партнёр — уведомлять его же не о чем. Туристов не уведомляем.
    if (senderId === partnerSide.user_id) return;
    if (senderId !== touristSide.user_id) {
      console.error(`[chat-notify] беседа ${conversationId}: сообщение не от участника беседы — уведомление не отправлено`);
      return;
    }

    // Чат с туристами на платформе есть только у оператора и гида
    // (INBOX_CHAT_CATEGORIES): остальным ролям отвечать негде.
    if (!INBOX_CHAT_CATEGORIES.has(category)) {
      console.error(`[chat-notify] беседа ${conversationId}: у роли «${partnerSide.role}» нет чата с туристами на платформе — уведомление не отправлено`);
      return;
    }

    const partner = (await db.query<{ id: string }>(
      `SELECT id FROM partners
        WHERE user_id = $1 AND category = $2
        ORDER BY created_at ASC NULLS LAST, id ASC LIMIT 1`,
      [partnerSide.user_id, category],
    )).rows[0];
    if (!partner) {
      console.error(`[chat-notify] беседа ${conversationId}: у собеседника с ролью «${partnerSide.role}» нет карточки категории «${category}» — о сообщении туриста он не узнает`);
      return;
    }

    // Дедуп серией: уведомляем только о первом непрочитанном. Запрос идёт
    // после вставки, поэтому «1» значит «это сообщение — единственное,
    // которого партнёр ещё не видел».
    const unread = (await db.query<{ count: string }>(
      `SELECT COUNT(cm.id)::text AS count
         FROM conversation_participants cp
         JOIN conversation_messages cm
           ON cm.conversation_id = cp.conversation_id
          AND cm.created_at > COALESCE(cp.last_read_at, '1970-01-01')
          AND cm.sender_id != cp.user_id
          AND cm.is_deleted = FALSE
        WHERE cp.conversation_id = $1 AND cp.user_id = $2`,
      [conversationId, partnerSide.user_id],
    )).rows[0];
    if (!unread) {
      console.error(`[chat-notify] беседа ${conversationId}: счёт непрочитанных у партнёра ${partner.id} не вернулся — уведомление не отправлено`);
      return;
    }
    if (parseInt(unread.count, 10) !== 1) return;

    const reach = await reachForPartner(partner.id);
    if (reach === null) {
      console.error(`[chat-notify] адрес партнёра ${partner.id} не прочитался — о сообщении в беседе ${conversationId} не сообщено`);
      return;
    }
    if (!reach.reachable) {
      console.error(`[chat-notify] у партнёра ${partner.id} нет ни MAX, ни Telegram — о сообщении в беседе ${conversationId} он узнает из кабинета`);
      return;
    }

    const subject = rows[0]?.subject ?? null;
    const senderName = touristSide.name;
    const excerpt = content.trim().replace(/\s+/g, ' ').slice(0, 200);

    const common = [
      '<b>Новое сообщение в чате Ведара</b>',
      subject ? `Тема: ${esc(subject)}` : '',
    ].filter(Boolean);
    const text = [
      ...common,
      senderName ? `Написал(а): ${esc(senderName)}` : '',
      excerpt ? `Сообщение: ${esc(excerpt)}` : '',
    ].filter(Boolean).join('\n');
    const stub = [
      ...common,
      'Имя автора и текст сообщения — в кабинете: в Telegram они не передаются.',
    ].join('\n');

    const res = await sendPdAlert({
      text,
      stub,
      buttons: [{ text: 'Открыть чат', url: `${getPublicBaseUrl()}/hub/${category}` }],
      to: { maxChatId: reach.maxChatId, telegramChatId: reach.telegramChatId },
    });
    if (!res.delivered && res.channel === 'none') {
      console.error(`[chat-notify] партнёру ${partner.id} о сообщении в беседе ${conversationId} не доставлено — ${res.reason}`);
    }
  } catch (err) {
    console.error('[chat-notify] уведомление о сообщении чата не отправлено, SQLSTATE', sqlstate(err));
  }
}
