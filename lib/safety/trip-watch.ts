/**
 * lib/safety/trip-watch.ts — единственный способ поставить и снять контроль
 * выхода (docs/safety/WATCH_MANIFEST.md, правило 1).
 *
 * Все пути создания — форма /register, чат Кузьмича в Telegram и MAX — пишут
 * одну и ту же строку `route_registrations` одним INSERT. Два INSERT'а в двух
 * местах — это две правды о том, какие поля у контроля обязательны, и они
 * разойдутся первой же новой колонкой.
 *
 * Сторожит этот контроль только `checkin-watchdog`; здесь — запись и закрытие.
 */
import { pool } from '@/lib/db-pool';
import { sendEmail } from '@/lib/email';
import { tgSend } from '@/lib/notifications/tg-send';
import { escapeHtml } from '@/lib/text/escape-html';
import { logText } from '@/lib/log/log-text';
import { formatKamchatkaTime } from '@/lib/safety/checkin-escalation';
import { telegramService } from '@/lib/notifications/telegram';

export type TripWatchSource = 'form' | 'telegram' | 'max';
export type TouristChannel = 'tg' | 'max';

export interface TripWatchInput {
  source: TripWatchSource;
  userId: string | null;
  routeName: string;
  routeDescription: string | null;
  startDate: string; // YYYY-MM-DD (по Камчатке)
  endDate: string;
  expectedReturnAt: Date | null;
  region: string;
  groupSize: number;
  groupMembers: unknown[] | null;
  leaderName: string;
  leaderPhone: string;
  leaderEmail: string | null;
  contactName: string;
  contactPhone: string;
  contactRelation: string | null;
  contactTelegramChatId: string | null;
  contactEmail: string | null;
  contactConsent: boolean;
  /** Канал к самому туристу — только у контроля из чата. */
  touristChat: { channel: TouristChannel; chatId: number } | null;
}

interface Queryable {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

export async function createTripWatch(input: TripWatchInput, db: Queryable = pool): Promise<string> {
  const tripKind = input.startDate === input.endDate ? 'day' : 'multi';
  const { rows } = await db.query(
    `INSERT INTO route_registrations
       (user_id, route_name, route_description, start_date, end_date, region,
        group_size, group_members, leader_name, leader_phone, leader_email,
        emergency_contact_name, emergency_contact_phone, emergency_contact_relation,
        emergency_contact_telegram_chat_id, emergency_contact_email,
        emergency_contact_consent, expected_return_at, trip_kind,
        source, tourist_chat_channel, tourist_chat_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
     RETURNING id`,
    [
      input.userId,
      input.routeName,
      input.routeDescription,
      input.startDate,
      input.endDate,
      input.region,
      input.groupSize,
      input.groupMembers ? JSON.stringify(input.groupMembers) : null,
      input.leaderName,
      input.leaderPhone,
      input.leaderEmail,
      input.contactName,
      input.contactPhone,
      input.contactRelation,
      input.contactTelegramChatId,
      input.contactEmail,
      input.contactConsent,
      input.expectedReturnAt,
      tripKind,
      input.source,
      input.touristChat?.channel ?? null,
      input.touristChat?.chatId ?? null,
    ],
  );
  const id = rows[0]?.id;
  if (typeof id !== 'string') throw new Error('route_registrations: INSERT не вернул id');
  return id;
}

export interface OpenWatch {
  id: string;
  route_name: string;
  expected_return_at: Date | null;
}

/** Открытые контроли, поставленные из этого чата (новые первыми). */
export async function openWatchesForChat(channel: TouristChannel, chatId: number): Promise<OpenWatch[]> {
  const { rows } = await pool.query<OpenWatch>(
    `SELECT id, route_name, expected_return_at
       FROM route_registrations
      WHERE tourist_chat_channel = $1 AND tourist_chat_id = $2 AND completed_at IS NULL
      ORDER BY created_at DESC`,
    [channel, chatId],
  );
  return rows;
}

/**
 * Закрыть контроль: человек вернулся. Закрывает только ОТКРЫТЫЙ контроль и
 * говорит, закрыл ли: повторное «вернулся» не должно читаться как новое
 * закрытие. Всех, кого уже встревожили, извещает об отбое (правило 10).
 */
export async function closeTripWatch(id: string, by: 'link' | 'chat'): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE route_registrations
        SET completed_at = now(), closed_by = $2, updated_at = now()
      WHERE id = $1 AND completed_at IS NULL`,
    [id, by],
  );
  const closed = (rowCount ?? 0) > 0;
  if (closed) {
    await announceToAlerted(id, (w) =>
      `Отбой тревоги: ${w.leader_name} вернулся с маршрута «${w.route_name}» ` +
      `(${by === 'chat' ? 'отметка в чате' : 'отметка по ссылке'}, ${formatKamchatkaTime(new Date())}). Искать не нужно.`);
  }
  return closed;
}

/**
 * «Жив, задерживаюсь»: сдвигает отсчёт тревог на эту минуту (лестница
 * не начинается заново, пройденные шаги остаются пройденными —
 * checkin-escalation.ts) и извещает тех, кого уже встревожили.
 */
export async function markTripWatchAlive(ids: string[], via: 'link' | 'chat'): Promise<number> {
  if (ids.length === 0) return 0;
  const { rows } = await pool.query<{ id: string }>(
    `UPDATE route_registrations SET checkin_confirmed_at = now(), updated_at = now()
      WHERE id = ANY($1::uuid[]) AND completed_at IS NULL
      RETURNING id`,
    [ids],
  );
  for (const r of rows) {
    await announceToAlerted(r.id, (w) =>
      `Турист на связи: ${w.leader_name} (маршрут «${w.route_name}») отметил, что всё в порядке и задерживается ` +
      `(${via === 'chat' ? 'в чате' : 'по ссылке'}, ${formatKamchatkaTime(new Date())}). ` +
      'Тревога отложена; если он снова пропадёт, лестница продолжится.');
  }
  return rows.length;
}

interface AlertedWatch {
  route_name: string;
  leader_name: string;
  contact_tg: string | null;
}

/**
 * Разослать весть тем, кому уже ушла тревога (журнал доставки,
 * status = 'sent'): контакту — тем же каналом, дежурному — в админ-чат.
 * Туристу не пишем: весть от него же. Не встревожили никого — молчим:
 * человек, которого не пугали, не должен получать «отбой».
 *
 * Отказ отправки не отменяет закрытия (человек вернулся — это факт), но
 * называется в логе: отбой, не дошедший до контакта, значит, что контакт
 * может вызвать спасателей к человеку, который уже дома.
 */
async function announceToAlerted(id: string, textFor: (w: AlertedWatch) => string): Promise<void> {
  try {
    const { rows: [w] } = await pool.query<AlertedWatch>(
      `SELECT route_name, leader_name, emergency_contact_telegram_chat_id::text AS contact_tg
         FROM route_registrations WHERE id = $1`,
      [id],
    );
    if (!w) return;
    const { rows: sent } = await pool.query<{ channel: string; recipient: string }>(
      `SELECT DISTINCT channel, recipient FROM route_registration_notifications
        WHERE registration_id = $1 AND status = 'sent'`,
      [id],
    );
    if (sent.length === 0) return;
    const text = textFor(w);

    const toAdmin = sent.some((n) => n.channel === 'admin_only' || n.recipient === 'admin');
    const toContactTg = sent.some((n) => n.channel === 'telegram' && n.recipient !== 'admin' && n.recipient !== 'tourist');
    const emails = [...new Set(sent.filter((n) => n.channel === 'email').map((n) => n.recipient))];

    if (toAdmin) {
      const r = await tgSend('trip-watch', escapeHtml(text));
      if (!r.ok) console.error('[trip-watch] весть дежурному не доставлена', logText(id), logText(r.reason));
    }
    if (toContactTg && w.contact_tg) {
      const r = await telegramService.sendMessage({ chatId: w.contact_tg, text: escapeHtml(text) });
      if (!r.success) console.error('[trip-watch] весть контакту в Telegram не доставлена', logText(id), logText(r.error ?? ''));
    }
    for (const to of emails) {
      const e = await sendEmail({ to, subject: 'Ведар: новости о туристе', text });
      if (!e.success) console.error('[trip-watch] письмо контакту не отправлено', logText(id), logText(e.error ?? ''));
    }
  } catch (err) {
    console.error('[trip-watch] весть встревоженным не разослана', logText(id), logText(err instanceof Error ? err.message : err));
  }
}
