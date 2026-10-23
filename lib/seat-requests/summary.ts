/**
 * lib/seat-requests/summary.ts — «/сводка» по запросам мест для оператора в
 * MAX (пилот «Камчатская рыбалка», 23.10). Только числа, тур, дата и время:
 * ни имени, ни телефона туриста — сообщение уходит в мессенджер.
 *
 * Включено флагом только для партнёров из SUMMARY_PARTNER_IDS: шаг за шагом,
 * сначала один пилот.
 */
import { pool } from '@/lib/db-pool';
import { escapeHtml } from '@/lib/text/escape-html';
import { TEST_STAND_PARTNER_IDS } from '@/lib/seat-requests/test-stand';

/** Партнёры, которым доступна /сводка. Пилот — «Камчатская рыбалка». */
export const SUMMARY_PARTNER_IDS: ReadonlySet<string> = new Set([
  '0aaa4f05-b479-418b-9d54-2b909783dfd7',
  // Тестовый стенд (lib/seat-requests/test-stand), 24.10.
  ...TEST_STAND_PARTNER_IDS,
]);

export function summaryEnabledFor(partnerId: string): boolean {
  return SUMMARY_PARTNER_IDS.has(partnerId);
}

/** «/сводка», «сводка», «/svodka», «/summary» — вся фраза, регистр не важен. */
export function isSummaryCommand(text: string): boolean {
  return /^\/?(сводка|svodka|summary)[.!]?$/i.test(text.trim());
}

export interface SeatSummary {
  pending: number;
  /** Самый старый ожидающий, минуты. null — ожидающих нет. */
  oldestPendingMin: number | null;
  todayIn: number;
  todayAnswered: number;
  /** Среднее время ответа за 7 дней, минуты. null — ответов не было. */
  avgResponseMin7d: number | null;
  answered7d: number;
  nearest: { title: string; tourDate: string; participants: number; deadlineAt: Date } | null;
}

export function formatDuration(min: number): string {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h < 48) return rest ? `${h} ч ${rest} мин` : `${h} ч`;
  return `${Math.floor(h / 24)} дн`;
}

function kamchatkaDateTime(d: Date): string {
  return d.toLocaleString('ru-RU', {
    timeZone: 'Asia/Kamchatka', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function ruDate(iso: string): string {
  const [y, mo, da] = iso.split('-');
  return y && mo && da ? `${da}.${mo}.${y}` : iso;
}

export function summaryText(s: SeatSummary): string {
  const lines = ['<b>Сводка по запросам мест</b>'];
  if (s.pending === 0) {
    lines.push('Ждут ответа: 0');
  } else {
    const oldest = s.oldestPendingMin === null ? '' : ` (самый старый — ${formatDuration(s.oldestPendingMin)})`;
    lines.push(`Ждут ответа: <b>${s.pending}</b>${oldest}`);
  }
  lines.push(`Сегодня пришло: ${s.todayIn} · отвечено: ${s.todayAnswered}`);
  lines.push(s.avgResponseMin7d === null
    ? 'Среднее время ответа за 7 дней: ответов не было'
    : `Среднее время ответа за 7 дней: ${formatDuration(s.avgResponseMin7d)} (ответов: ${s.answered7d})`);
  if (s.nearest) {
    lines.push(
      `Ближайший срок: до ${kamchatkaDateTime(s.nearest.deadlineAt)} — «${escapeHtml(s.nearest.title)}», `
      + `${ruDate(s.nearest.tourDate)}, ${s.nearest.participants} чел.`,
    );
  }
  lines.push('Время — Камчатка.');
  return lines.join('\n');
}

/** Читает сводку партнёра. 'db_error' — база не ответила. */
export async function readSeatSummary(partnerId: string): Promise<SeatSummary | 'db_error'> {
  try {
    const counts = await pool.query<{
      pending: string; oldest_min: string | null; today_in: string; today_answered: string;
      avg_min: string | null; answered_7d: string;
    }>(
      `WITH today AS (
         SELECT (date_trunc('day', NOW() AT TIME ZONE 'Asia/Kamchatka') AT TIME ZONE 'Asia/Kamchatka') AS start
       )
       SELECT
         COUNT(*) FILTER (WHERE r.status = 'pending' AND r.answered_at IS NULL AND r.deadline_at > NOW()) AS pending,
         EXTRACT(EPOCH FROM NOW() - MIN(r.created_at) FILTER (
           WHERE r.status = 'pending' AND r.answered_at IS NULL AND r.deadline_at > NOW())) / 60 AS oldest_min,
         COUNT(*) FILTER (WHERE r.created_at >= t.start) AS today_in,
         COUNT(*) FILTER (WHERE r.answered_at >= t.start) AS today_answered,
         AVG(EXTRACT(EPOCH FROM r.answered_at - r.created_at) / 60) FILTER (
           WHERE r.answered_at >= NOW() - INTERVAL '7 days') AS avg_min,
         COUNT(*) FILTER (WHERE r.answered_at >= NOW() - INTERVAL '7 days') AS answered_7d
       FROM tour_seat_requests r CROSS JOIN today t
       WHERE r.operator_id = $1
       GROUP BY t.start`,
      [partnerId],
    );
    const nearest = await pool.query<{ title: string; tour_date: string; participants: number; deadline_at: Date }>(
      `SELECT t.title, r.tour_date::text AS tour_date, r.participants, r.deadline_at
         FROM tour_seat_requests r JOIN operator_tours t ON t.id = r.tour_id
        WHERE r.operator_id = $1 AND r.status = 'pending' AND r.answered_at IS NULL AND r.deadline_at > NOW()
        ORDER BY r.deadline_at ASC LIMIT 1`,
      [partnerId],
    );
    const c = counts.rows[0];
    const n = nearest.rows[0];
    return {
      pending: Number(c?.pending ?? 0),
      oldestPendingMin: c?.oldest_min == null ? null : Number(c.oldest_min),
      todayIn: Number(c?.today_in ?? 0),
      todayAnswered: Number(c?.today_answered ?? 0),
      avgResponseMin7d: c?.avg_min == null ? null : Number(c.avg_min),
      answered7d: Number(c?.answered_7d ?? 0),
      nearest: n ? { title: n.title, tourDate: n.tour_date, participants: n.participants, deadlineAt: new Date(n.deadline_at) } : null,
    };
  } catch (err) {
    const code = (err as { code?: string })?.code ?? 'нет SQLSTATE';
    console.error('[seat-summary] сводка не прочитана, SQLSTATE', code);
    return 'db_error';
  }
}

export const SUMMARY_DB_ERROR = 'Сводка сейчас не собралась — база не ответила. Попробуйте через минуту.';
