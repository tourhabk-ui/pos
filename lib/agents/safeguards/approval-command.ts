/**
 * Команды владельца /approve_<id> и /reject_<id> в Telegram — решение по
 * запросу из agent_approvals.
 *
 * Находка C3 проверки CRM и каналов 25.10 (перепроверена 11.11): команда не
 * срабатывала НИ РАЗУ. `agent_approvals.id` — UUID (миграция 063), а поиск по
 * началу id шёл `id LIKE $1`; у PostgreSQL нет оператора LIKE для uuid, и
 * запрос падал 42883 «operator does not exist: uuid ~~ unknown» (проверено на
 * PostgreSQL 16). Владелец получал «Ошибка: operator does not exist…».
 *
 * Новых запросов с 27.08 не создаёт никто: решения агентов принимает ядро
 * (lib/agents/kernel/policy, allow/deny), ApprovalRequired не вызывается.
 * Команда оставлена для записей, которые ещё ждут решения, и в меню
 * консоли больше не обещается.
 */
import { pool } from '@/lib/db-pool';
import { logSwallowedFailure } from '@/lib/observability/swallowed';
import { escapeHtml } from '@/lib/text/escape-html';

/** Поиск ждущего запроса по началу id. Приведение к тексту — у uuid нет LIKE. */
export const APPROVAL_LOOKUP_SQL = `SELECT id, description, action_type FROM agent_approvals
 WHERE id::text LIKE $1 AND status = 'pending' ORDER BY created_at LIMIT 2`;

/** Решение — только по ещё ждущему: второе нажатие не перепишет первое. */
export const APPROVAL_DECIDE_SQL = `UPDATE agent_approvals SET status = $1, execution_status = $2, reviewed_at = NOW(),
 review_notes = $3 WHERE id = $4 AND status = 'pending'`;

export type ApprovalCommand = { approve: boolean; prefix: string };

/** «/approve_1a2b3c4d» → решение и начало id; не команда или не id — null. */
export function parseApprovalCommand(cmd: string): ApprovalCommand | null {
  const m = /^\/(approve|reject)_([0-9a-f-]+)$/i.exec(cmd.trim());
  if (!m) return null;
  const prefix = m[2]!.toLowerCase();
  // Восемь знаков в уведомлении; меньше семи — слишком широкий поиск.
  if (prefix.replace(/-/g, '').length < 7) return null;
  return { approve: m[1]!.toLowerCase() === 'approve', prefix };
}

/** Выполнить команду и ответить владельцу одним сообщением. */
export async function runApprovalCommand(cmd: string, reply: (html: string) => Promise<void>): Promise<void> {
  const parsed = parseApprovalCommand(cmd);
  if (!parsed) {
    await reply('Неверный формат. Нужно /approve_&lt;id&gt; или /reject_&lt;id&gt;, id — из уведомления.');
    return;
  }
  const shown = escapeHtml(parsed.prefix);
  try {
    const { rows } = await pool.query<{ id: string; description: string | null; action_type: string }>(
      APPROVAL_LOOKUP_SQL, [`${parsed.prefix}%`],
    );
    if (rows.length === 0) {
      await reply(`Запрос <code>${shown}</code> не найден среди ждущих решения.`);
      return;
    }
    if (rows.length > 1) {
      await reply(`Начало <code>${shown}</code> подходит к нескольким запросам — пришлите id длиннее.`);
      return;
    }
    const { id, description, action_type } = rows[0]!;
    const res = await pool.query(APPROVAL_DECIDE_SQL, [
      parsed.approve ? 'approved' : 'rejected',
      // Отклонённому исполнять нечего: 'rejected' CHECK execution_status (066)
      // не допускает — прежний /reject_ упал бы и на нём (23514).
      parsed.approve ? 'assigned' : null,
      `${parsed.approve ? 'Approved' : 'Rejected'} via Telegram bot`,
      id,
    ]);
    if (res.rowCount !== 1) {
      await reply(`Запрос <code>${shown}</code> уже решён — повторно не меняю.`);
      return;
    }
    await reply(
      `<b>${parsed.approve ? 'Одобрено' : 'Отклонено'}</b>\n\nТип: <code>${escapeHtml(action_type)}</code>\n${escapeHtml(description ?? '')}`,
    );
  } catch (err) {
    logSwallowedFailure('approval-command', 'решение по запросу agent_approvals', err);
    await reply('Не смог записать решение: база не ответила. Попробуйте позже.');
  }
}
