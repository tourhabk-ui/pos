import webpush from 'web-push';
import { pool } from '@/lib/db-pool';

const { NEXT_PUBLIC_VAPID_KEY, VAPID_PRIVATE_KEY, VAPID_EMAIL } = process.env;

if (NEXT_PUBLIC_VAPID_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    VAPID_EMAIL ?? 'mailto:info@vedarai.ru',
    NEXT_PUBLIC_VAPID_KEY,
    VAPID_PRIVATE_KEY,
  );
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  icon?: string;
  tag?: string;   // дедупликация: одно уведомление на событие, повтор заменяет предыдущее
}

export interface PushBroadcastResult {
  total: number;    // всего подписок в пуле
  sent: number;     // успешно доставлено
  failed: number;   // сетевые/протокольные ошибки
  removed: number;  // удалено истёкших подписок
}

/**
 * Send a push notification to all subscriptions of a user (or all users if userId omitted).
 * Stale endpoints are automatically removed.
 */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<void> {
  if (!NEXT_PUBLIC_VAPID_KEY || !VAPID_PRIVATE_KEY) return;

  const { rows } = await pool.query<{ id: string; endpoint: string; p256dh: string; auth: string }>(
    `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1`,
    [userId],
  );

  await Promise.allSettled(
    rows.map(async sub => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify({ ...payload, icon: payload.icon ?? '/icons/icon-192.png' }),
        );
        await pool.query(`UPDATE push_subscriptions SET last_used = NOW() WHERE id = $1`, [sub.id]);
      } catch (err: unknown) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          // Subscription expired — clean up
          await pool.query(`DELETE FROM push_subscriptions WHERE id = $1`, [sub.id]);
        }
      }
    }),
  );
}

export async function sendPushBroadcast(
  payload: PushPayload,
  limit = 500,
): Promise<PushBroadcastResult> {
  if (!NEXT_PUBLIC_VAPID_KEY || !VAPID_PRIVATE_KEY) {
    return { total: 0, sent: 0, failed: 0, removed: 0 };
  }

  const { rows } = await pool.query<{ id: string; endpoint: string; p256dh: string; auth: string }>(
    `SELECT id, endpoint, p256dh, auth FROM push_subscriptions ORDER BY last_used DESC LIMIT $1`,
    [limit],
  );

  let sent = 0, failed = 0, removed = 0;

  await Promise.allSettled(
    rows.map(async sub => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify({ ...payload, icon: payload.icon ?? '/icons/icon-192.png' }),
        );
        sent++;
        await pool.query(`UPDATE push_subscriptions SET last_used = NOW() WHERE id = $1`, [sub.id]);
      } catch (err: unknown) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          removed++;
          await pool.query(`DELETE FROM push_subscriptions WHERE id = $1`, [sub.id]);
        } else {
          failed++;
        }
      }
    }),
  );

  return { total: rows.length, sent, failed, removed };
}
