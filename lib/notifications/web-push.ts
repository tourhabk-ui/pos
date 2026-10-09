import webpush from 'web-push';
import { pool } from '@/lib/db-pool';
import { checkNotificationAllowed, type NotificationKind } from '@/lib/notifications/preferences-gate';

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
 * Push всем подпискам человека. Истёкшие подписки удаляются по ходу.
 *
 * `kind` обязателен и умолчания не имеет намеренно: умолчание молча зачислило
 * бы новое уведомление в самый безобидный род, и настройка получателя тихо
 * перестала бы его касаться. Пусть автор нового вызова решает вслух.
 *
 * Настройки спрашиваются ЗДЕСЬ, а не на местах вызова: до 23.08.2026 их не
 * спрашивал никто, и повторять это по одному разу в каждом роуте — тот же
 * способ разъехаться, каким разъехались двенадцать копий публичного URL.
 */
export async function sendPushToUser(
  userId: string,
  payload: PushPayload,
  opts: { kind: NotificationKind; type?: string },
): Promise<void> {
  if (!NEXT_PUBLIC_VAPID_KEY || !VAPID_PRIVATE_KEY) return;

  const decision = await checkNotificationAllowed(userId, opts.kind, 'push', opts.type);
  if (decision.verdict === 'suppress') {
    // След обязателен: «почему не пришло» — вопрос, который зададут, и ответ
    // на него не должен требовать чтения кода.
    console.info(`[web-push] не отправлено (${opts.kind}): ${decision.reason}`);
    return;
  }
  if (decision.verdict === 'unknown') {
    // Третий исход решается ЗДЕСЬ и в пользу отправки: потерянное
    // подтверждение брони дороже лишнего уведомления, а сам отказ уже
    // записан в лог шлюзом — «не смогли» не выдаётся за «разрешено».
    console.error(`[web-push] настройки не прочитаны, шлём (${opts.kind}): ${decision.reason}`);
  }

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
