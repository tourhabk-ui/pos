/**
 * ApprovalRequired — очередь действий, требующих одобрения администратора.
 *
 * Forbidden actions никогда не выполняются — возвращают ошибку.
 * Review actions создают pending запись в agent_approvals + Telegram уведомление.
 * Неизвестный `action.type` (в т.ч. любой тип из старого реестра ниже, если
 * его когда-нибудь позовут снова) идёт в 'review' по умолчанию — см. `request()`.
 *
 * ── Находка 26.08 (сверка внешнего аудита с кодом) ────────────────────────
 *
 * До этой правки `ACTION_CATEGORIES`/`EXECUTOR_MAP` перечисляли 20+ типов
 * действий, унаследованных из совета директоров 13 AI-агентов, удалённого в
 * апреле 2026 как «неэффективный театр» (AGENTS.md, коммиты `9da9e8d2`,
 * `5d4d83f9`). Реестр исполнителей ссылался на `admin`/`eco`/`quality`/
 * `content`/`hacker`/`vibe_coder`/`security`/`finance` — агентства, которых
 * в `lib/agents/agencies/` больше нет ни одного файла. Опаснее самих мёртвых
 * ссылок было то, ЧТО именно объявлялось `'safe'` (автоодобрение без
 * человека): `archive_sos`, `tour_suspend`, `security_block`, `flag_payment`,
 * `code_change`, `send_notification` — притом что ни один вызывающий код во
 * всём репозитории не зовёт `request()` ни с одним из этих типов (grep по
 * `approvalRequired.request(` — единственный живой вызов ниже). То есть
 * заряженное, но фактически не нажимаемое ружьё: рискованно не сегодня, а в
 * день, когда кто-то свяжет новый код с одним из этих имён, унаследует
 * категорию «safe» и исполнителя, которого не существует.
 *
 * Реестр урезан до того, что РЕАЛЬНО вызывается (`schedule_suggest` из
 * `operator-agency.ts`, единственный executor — `rescue`, который
 * действительно существует). Расширять — только вместе с настоящим
 * вызывающим кодом и намеренным выбором категории, не «на будущее».
 * Сторож: `tests/unit/approval-required.test.ts` (executor'ы — реальные
 * файлы агентств, а не имена из удалённого совета).
 */

import { pool } from '@/lib/db-pool';
import { telegramService } from '@/lib/notifications/telegram';
import { auditLog } from './audit-log';

// ── Action categories ──────────────────────────────────────────────────────────

type ActionCategory = 'safe' | 'review' | 'forbidden';

const ACTION_CATEGORIES: Record<string, ActionCategory> = {
  // Safe — применяется автоматически. Единственный тип, который реально
  // зовётся (operator-agency.ts, чат оператора — черновик тура, низкий риск).
  // До 27.08 он назывался `schedule_suggest` — имя не совпадало с действием, и
  // из этого вырастало фиктивное второе исполнение: запись клалась с
  // execution_status='assigned' и исполнителем rescue, INSERT черновика делал
  // сам вызывающий, а батч-исполнитель потом «исполнял» запись как
  // Rescue-анализ расписания — действие, никак не связанное с черновиком.
  // Теперь имя называет действие, а запись — аудит уже принятого решения.
  tour_create_draft: 'safe',

  // Forbidden — никогда не выполняется агентом.
  data_delete:      'forbidden',
  auth_bypass:       'forbidden',
  schema_change:     'forbidden',
  payment_exec:      'forbidden',
  safeguard_modify:  'forbidden',
};

// ── Матрица исполнителей ────────────────────────────────────────────────────
// Какой агент исполняет какой тип инициативы. Держать в СИНХРОНЕ с реальными
// файлами lib/agents/agencies/*.ts — сторож проверяет это через existsSync.

// Пусто намеренно: единственный живой тип (`tour_create_draft`) исполняется
// вызывающим кодом сразу после auto-approve, отложенного исполнителя у него
// нет и быть не должно. Прежняя запись `schedule_suggest → rescue` назначала
// Rescue исполнителем действия, которое Rescue не делал (см. ACTION_CATEGORIES).
const EXECUTOR_MAP: Record<string, { agent_id: string; agent_name: string }> = {};

/**
 * Неизвестный/неназначенный тип — исполнитель НЕ выдумывается (было
 * `admin`, а такого агентства уже нет). 'unassigned' — третье состояние: не
 * «безопасно исполнит кто-то», а «пока некому, разбирает человек».
 */
function getExecutor(actionType: string): { agent_id: string; agent_name: string } {
  return EXECUTOR_MAP[actionType] ?? { agent_id: 'unassigned', agent_name: 'Не назначено' };
}

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ApprovalAction {
  type: string;
  description: string;
  context: Record<string, unknown>;
  requested_by: string;
  expires_hours?: number;
}

export interface Approval {
  id:           string;
  action_type:  string;
  description:  string | null;
  context:      Record<string, unknown>;
  status:       'pending' | 'approved' | 'rejected' | 'expired';
  requested_by: string | null;
  reviewed_by:  number | null;
  reviewed_at:  Date | null;
  review_notes: string | null;
  expires_at:   Date | null;
  created_at:   Date;
}

export interface ApprovalRequestResult {
  needs_approval: boolean;
  id?:     string;
  reason?: string;
}

// ── ApprovalRequired ───────────────────────────────────────────────────────────

export class ApprovalRequired {
  /** Проверить категорию и создать запрос на одобрение (если нужно) */
  async request(action: ApprovalAction): Promise<ApprovalRequestResult> {
    const category = ACTION_CATEGORIES[action.type] ?? 'review';

    if (category === 'forbidden') {
      await auditLog.write({
        event_type: 'safeguard_blocked',
        actor:      action.requested_by,
        resource:   action.type,
        details:    { reason: 'forbidden_action', context: action.context },
      });
      return { needs_approval: true, reason: `Действие '${action.type}' запрещено системой` };
    }

    if (category === 'safe') {
      // Safe-действие исполняет ВЫЗЫВАЮЩИЙ код сразу после этого ответа —
      // запись здесь аудит решения, а не задача на потом. Поэтому
      // execution_status = 'done', НЕ 'assigned': 'assigned' означал бы
      // «ждёт исполнителя», и батч-исполнитель честно исполнил бы её второй
      // раз — уже случалось (schedule_suggest → Rescue-анализ расписания).
      const expiresHours = action.expires_hours ?? 24;
      const executor = getExecutor(action.type);
      const { rows } = await pool.query<{ id: string }>(`
        INSERT INTO agent_approvals (
          action_type, description, context, status, requested_by,
          reviewed_at, review_notes, expires_at,
          executor_agent_id, executor_name, execution_status
        )
        VALUES ($1, $2, $3, 'approved', $4, NOW(), $5, NOW() + ($6 || ' hours')::interval, $7, $8, 'done')
        RETURNING id
      `, [
        action.type,
        action.description,
        JSON.stringify(action.context),
        action.requested_by,
        'auto_approved_safe_action',
        expiresHours,
        executor.agent_id,
        executor.agent_name,
      ]);

      const approvalId = rows[0]?.id;

      await auditLog.write({
        event_type: 'approval_granted',
        actor:      action.requested_by,
        resource:   action.type,
        details:    { approval_id: approvalId, category: 'safe', auto: true, executor: executor.agent_name },
      });

      return { needs_approval: false, id: approvalId };
    }

    // REVIEW — создать запись с исполнителем (но ждёт одобрения)
    const expiresHours = action.expires_hours ?? 24;
    const executor = getExecutor(action.type);
    const { rows } = await pool.query<{ id: string }>(`
      INSERT INTO agent_approvals (
        action_type, description, context, requested_by, expires_at,
        executor_agent_id, executor_name
      )
      VALUES ($1, $2, $3, $4, NOW() + ($5 || ' hours')::interval, $6, $7)
      RETURNING id
    `, [
      action.type,
      action.description,
      JSON.stringify(action.context),
      action.requested_by,
      expiresHours,
      executor.agent_id,
      executor.agent_name,
    ]);

    const approvalId = rows[0].id;

    await auditLog.write({
      event_type: 'approval_requested',
      actor:      action.requested_by,
      resource:   action.type,
      details:    { approval_id: approvalId, description: action.description },
    });

    await this.notifyAdmin(approvalId, action).catch(() => null);

    return { needs_approval: true, id: approvalId };
  }

  async approve(id: string, reviewerId: number, notes?: string): Promise<void> {
    await pool.query(`
      UPDATE agent_approvals
      SET status = 'approved', reviewed_by = $2, reviewed_at = NOW(), review_notes = $3
      WHERE id = $1 AND status = 'pending'
    `, [id, reviewerId, notes ?? null]);

    await auditLog.write({
      event_type: 'approval_granted',
      actor:      String(reviewerId),
      resource:   id,
      details:    { notes },
    });
  }

  async reject(id: string, reviewerId: number, notes?: string): Promise<void> {
    await pool.query(`
      UPDATE agent_approvals
      SET status = 'rejected', reviewed_by = $2, reviewed_at = NOW(), review_notes = $3
      WHERE id = $1 AND status = 'pending'
    `, [id, reviewerId, notes ?? null]);

    await auditLog.write({
      event_type: 'approval_rejected',
      actor:      String(reviewerId),
      resource:   id,
      details:    { notes },
    });
  }

  async pending(): Promise<Approval[]> {
    const { rows } = await pool.query<Approval>(`
      SELECT id, action_type, description, context, status, requested_by, reviewed_by, reviewed_at, review_notes, expires_at, created_at FROM agent_approvals
      WHERE status = 'pending'
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY created_at ASC
      LIMIT 50
    `);
    return rows;
  }

  async expireStale(): Promise<number> {
    const { rowCount } = await pool.query(`
      UPDATE agent_approvals
      SET status = 'expired'
      WHERE status = 'pending'
        AND expires_at IS NOT NULL
        AND expires_at <= NOW()
    `);
    return rowCount ?? 0;
  }

  private async notifyAdmin(id: string, action: ApprovalAction): Promise<void> {
    // Отправляем в личку владельца (TELEGRAM_OWNER_ID), а не в группу
    const chatId = process.env.TELEGRAM_OWNER_ID ?? process.env.TELEGRAM_CHAT_ID;
    const token  = process.env.TELEGRAM_BOT_TOKEN;
    if (!chatId || !token) return;

    const shortId = id.slice(0, 8);
    const text = [
      '<b>Запрос на одобрение</b>',
      '',
      `Тип: <code>${action.type}</code>`,
      `Описание: ${action.description}`,
      `Запросил: ${action.requested_by}`,
      '',
      `/approve_${shortId} — одобрить`,
      `/reject_${shortId} — отклонить`,
    ].join('\n');

    await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    }).catch(() => {});
  }
}

export const approvalRequired = new ApprovalRequired();
