/**
 * lib/crm/chat-events.ts — сообщение чата партнёр ↔ турист в ленте клиента
 * (CRM фаза 1, шаг 1б, #2325).
 *
 * Лента получает ФАКТ сообщения и направление, не текст: содержимое чата —
 * слова двух людей, ленте оно не нужно, а модели (1д) тем более. Клиент
 * находится по аккаунту туриста у партнёра-участника беседы; турист без
 * клиента у этого партнёра (ничего не бронировал) события не оставляет.
 *
 * Хук в `chat.service.sendMessage`: никогда не роняет отправку, отказ — в лог
 * с SQLSTATE.
 */
import { pool } from '@/lib/db-pool';
import { ROLE_TO_CATEGORY } from '@/lib/crm/partner-context';
import { recordUserEvent } from '@/lib/crm/events';

interface Queryable {
  query: typeof pool.query;
}

function sqlstate(err: unknown): string {
  return (err as { code?: string })?.code ?? 'нет SQLSTATE';
}

export async function recordChatMessageQuietly(
  conversationId: string,
  senderId: string,
  db: Queryable = pool,
): Promise<void> {
  try {
    const { rows } = await db.query<{ user_id: string; role: string }>(
      `SELECT user_id, role FROM conversation_participants WHERE conversation_id = $1`,
      [conversationId],
    );
    // Лента клиента — про беседу один на один; групповые и служебные беседы
    // клиенту не принадлежат.
    if (rows.length !== 2) return;
    const partnerSide = rows.find((r) => ROLE_TO_CATEGORY[r.role] !== undefined);
    const touristSide = rows.find((r) => r !== partnerSide);
    if (!partnerSide || !touristSide || partnerSide.user_id === touristSide.user_id) return;

    const partner = (await db.query<{ id: string }>(
      `SELECT id FROM partners
        WHERE user_id = $1 AND category = $2
        ORDER BY created_at ASC NULLS LAST, id ASC LIMIT 1`,
      [partnerSide.user_id, ROLE_TO_CATEGORY[partnerSide.role]],
    )).rows[0];
    if (!partner) return;

    const outgoing = senderId === partnerSide.user_id;
    await recordUserEvent({
      partnerId: partner.id,
      userId: touristSide.user_id,
      kind: outgoing ? 'message_out' : 'message_in',
      actorKind: outgoing ? 'partner_user' : 'tourist',
      actorUserId: senderId,
      title: outgoing ? 'Сообщение клиенту в чате платформы' : 'Сообщение от клиента в чате платформы',
      payload: { conversation_id: conversationId },
    }, db);
  } catch (err) {
    console.error('[crm] событие чата не записано, SQLSTATE', sqlstate(err));
  }
}
