/**
 * Неотправленные заявки — хранение и одно напоминание (возврат брошенной
 * заявки, слово владельца 01.11). Таблица — миграция 1363.
 *
 * Правила (lib/requests/abandoned-reminder.ts решает «пора ли» и «что писать»):
 *  · черновик пишется только вошедшему человеку, у которого есть MAX или
 *    Telegram; канал — MAX, если есть, иначе Telegram;
 *  · без отдельной галочки (lib/legal/recontact-consent.ts) напоминания нет;
 *    снятая галочка или кнопка «Не напоминать» — отзыв;
 *  · напоминание одно (reminders_sent ≤ 1 держит и база), отметка пишется
 *    ДО отправки — сбой отправки не превращается в повтор;
 *  · Telegram — без ПД и без названия; отправляет заявку сам человек.
 */
import { randomBytes } from 'crypto';
import { pool } from '@/lib/db-pool';
import { RECONTACT_CONSENT_VERSION } from '@/lib/legal/recontact-consent';
import { buildReminder, reminderDue, type AbandonedDraft, type ReminderChannel } from '@/lib/requests/abandoned-reminder';
import { maxSendToUser } from '@/lib/notifications/max-channel';
import { tgSend } from '@/lib/notifications/tg-send';

export const COMMENT_MAX = 2000;

export interface UserReach { channel: ReminderChannel | null; maxUserId: string | null; tgChatId: string | null }

export async function readUserReach(userId: string): Promise<UserReach> {
  const { rows } = await pool.query<{ max_user_id: string | null; tg: string | null }>(
    `SELECT max_user_id::text AS max_user_id, COALESCE(telegram_chat_id::text, telegram_id::text) AS tg
       FROM users WHERE id = $1::uuid`, [userId]);
  const r = rows[0];
  if (!r) return { channel: null, maxUserId: null, tgChatId: null };
  return { channel: r.max_user_id ? 'max' : r.tg ? 'telegram' : null, maxUserId: r.max_user_id, tgChatId: r.tg };
}

export function newResumeToken(): string {
  return randomBytes(24).toString('base64url');
}

/** Сохранить/обновить черновик. Галочка снята — согласие отзывается. */
export async function saveDraft(input: {
  userId: string; token: string | null; comment: string; title: string | null; consent: boolean;
}): Promise<{ token: string; channel: ReminderChannel | null }> {
  const reach = await readUserReach(input.userId);
  const comment = input.comment.slice(0, COMMENT_MAX);
  const title = input.title ? input.title.slice(0, 120) : null;
  if (input.token) {
    const { rows } = await pool.query<{ resume_token: string }>(
      `UPDATE request_drafts SET comment = $3, title = $4, channel = $5,
              recontact_consent_version = CASE WHEN $6 THEN $7 ELSE recontact_consent_version END,
              recontact_consent_at = CASE WHEN $6 AND recontact_consent_at IS NULL THEN NOW() ELSE recontact_consent_at END,
              recontact_withdrawn_at = CASE WHEN $6 THEN NULL WHEN recontact_consent_at IS NOT NULL THEN COALESCE(recontact_withdrawn_at, NOW()) ELSE recontact_withdrawn_at END
        WHERE resume_token = $1 AND user_id = $2::uuid AND submitted_at IS NULL
        RETURNING resume_token`,
      [input.token, input.userId, comment, title, reach.channel, input.consent, RECONTACT_CONSENT_VERSION]);
    if (rows[0]) return { token: rows[0].resume_token, channel: reach.channel };
  }
  const token = newResumeToken();
  await pool.query(
    `INSERT INTO request_drafts (resume_token, user_id, channel, title, comment, recontact_consent_version, recontact_consent_at)
     VALUES ($1, $2::uuid, $3, $4, $5, $6, CASE WHEN $6::text IS NULL THEN NULL ELSE NOW() END)`,
    [token, input.userId, reach.channel, title, comment, input.consent ? RECONTACT_CONSENT_VERSION : null]);
  return { token, channel: reach.channel };
}

export async function markDraftSubmitted(userId: string, token: string): Promise<void> {
  await pool.query(
    `UPDATE request_drafts SET submitted_at = NOW() WHERE resume_token = $1 AND user_id = $2::uuid AND submitted_at IS NULL`,
    [token, userId]);
}

/** По ключу из ссылки: только текст пожелания и название — без ПД. */
export async function readDraftByToken(token: string): Promise<{ comment: string | null; title: string | null; submitted: boolean; withdrawn: boolean } | null> {
  const { rows } = await pool.query<{ comment: string | null; title: string | null; submitted_at: Date | null; recontact_withdrawn_at: Date | null }>(
    `SELECT comment, title, submitted_at, recontact_withdrawn_at FROM request_drafts WHERE resume_token = $1`, [token]);
  const r = rows[0];
  return r ? { comment: r.comment, title: r.title, submitted: !!r.submitted_at, withdrawn: !!r.recontact_withdrawn_at } : null;
}

export async function withdrawByToken(token: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE request_drafts SET recontact_withdrawn_at = COALESCE(recontact_withdrawn_at, NOW()) WHERE resume_token = $1`, [token]);
  return (rowCount ?? 0) > 0;
}

export interface SweepResult { due: number; sent: number; failed: number; noAddress: number }

/** Один проход: найти черновики, которым пора, и отправить по одному напоминанию. */
export async function sweepAbandonedDrafts(base: string, opts: { dryRun?: boolean; now?: Date } = {}): Promise<SweepResult> {
  const now = opts.now ?? new Date();
  const res: SweepResult = { due: 0, sent: 0, failed: 0, noAddress: 0 };
  const { rows } = await pool.query<{
    id: string; user_id: string; created_at: Date; submitted_at: Date | null; reminders_sent: number;
    recontact_consent_version: string | null; recontact_withdrawn_at: Date | null; channel: ReminderChannel | null;
    resume_token: string; title: string | null;
  }>(
    `SELECT id::text, user_id::text, created_at, submitted_at, reminders_sent, recontact_consent_version,
            recontact_withdrawn_at, channel, resume_token, title
       FROM request_drafts
      WHERE submitted_at IS NULL AND reminders_sent = 0 AND recontact_withdrawn_at IS NULL
        AND recontact_consent_version = $1
        AND created_at <= NOW() - INTERVAL '1 hour' AND created_at >= NOW() - INTERVAL '72 hours'
      ORDER BY created_at LIMIT 200`, [RECONTACT_CONSENT_VERSION]);
  for (const r of rows) {
    const draft: AbandonedDraft = {
      createdAt: new Date(r.created_at), submittedAt: r.submitted_at, remindersSent: r.reminders_sent,
      recontactConsentVersion: r.recontact_consent_version, recontactWithdrawn: !!r.recontact_withdrawn_at,
      channel: r.channel, resumeToken: r.resume_token, title: r.title,
    };
    if (!reminderDue(draft, now)) continue;
    res.due++;
    if (opts.dryRun) continue;
    const reach = await readUserReach(r.user_id);
    const addr = draft.channel === 'max' ? reach.maxUserId : reach.tgChatId;
    if (!addr) { res.noAddress++; continue; }
    // Отметка ДО отправки: напоминание одно, даже если отправка упадёт.
    const claim = await pool.query(
      `UPDATE request_drafts SET reminders_sent = 1, reminded_at = NOW() WHERE id = $1::bigint AND reminders_sent = 0`, [r.id]);
    if ((claim.rowCount ?? 0) === 0) continue;
    const msg = buildReminder(draft, base);
    const out = draft.channel === 'max'
      ? await maxSendToUser(addr, msg.text, { buttons: [{ text: msg.button.label, url: msg.button.url }] })
      : await tgSend('request-drafts', msg.text.replace(/&/g, '&amp;').replace(/</g, '&lt;'), { chatId: addr, button: msg.button });
    if (out.ok) res.sent++; else { res.failed++; console.warn('[request-drafts] reminder failed', draft.channel, JSON.stringify(out)); }
  }
  return res;
}
