/**
 * app/api/admin/execute-all/route.ts
 *
 * ONE-SHOT BATCH EXECUTOR
 * Запускает все ОДОБРЕННЫЕ ЧЕЛОВЕКОМ инициативы немедленно.
 *
 * POST /api/admin/execute-all?hours=12 (admin-JWT) — исполнение
 * GET  /api/admin/execute-all?stats=1   (admin-JWT) — только чтение статистики
 *
 * 1. Auto-migrates DB (adds missing columns) — идемпотентно (IF NOT EXISTS)
 * 2. Backfill: все старые approved → execution_status='assigned'
 * 3. Выполняет все assigned инициативы (без лимита 5)
 *
 * ── POST и атомарный claim 27.08 (P0 внешнего аудита) ─────────────────────
 *
 * Исполнение переведено с GET на POST: мутация по GET исполнялась бы любым
 * префетчем/переходом по ссылке, а cookie-аутентификация без метода-барьера
 * оставляла CSRF-поверхность. POST дополнительно сверяет Origin с хостом
 * запроса, когда браузер его прислал. GET остался только у stats-режима —
 * он ничего не меняет, и владельцу удобно смотреть его из адресной строки.
 *
 * Выборка и захват инициатив слиты в ОДИН запрос
 * (UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING):
 * раньше SELECT и последующий UPDATE in_progress шли раздельно, и два
 * параллельных вызова могли взять одну инициативу и исполнить её дважды —
 * а исполнители умеют настоящие мутации (блокировки, комиссии, туры).
 *
 * ── Сужение доступа 27.08 (сверка внешнего аудита с кодом) ────────────────
 *
 * До этого дня ручка принимала CRON_SECRET и имела режим ?force=1, который
 * одним запросом одобрял ВСЕ pending-заявки и тут же их исполнял — а
 * initiative-executor умеет настоящие мутации: блокировку пользователей и
 * IP, архив SOS-событий, приостановку туров, смену комиссий операторов.
 * CRON_SECRET — секрет ДЛЯ КРОНОВ, он лежит в GitHub Secrets и настройках
 * внешних расписаний, то есть расшарен куда шире, чем право «исполнить всё».
 * Ни один workflow/скрипт ручку не звал (grep по репо — ноль ссылок) —
 * заряженное, но не нажимаемое ружьё, того же рода, что ACTION_CATEGORIES
 * до PR #1399.
 *
 * Теперь: только admin-JWT (владелец в браузере/панели), а force-режима нет
 * вовсе — одобрение поштучное, через Telegram (/approve_*) или админку, как
 * и задумано очередью agent_approvals. Батч-исполнение УЖЕ одобренного
 * остаётся: оно не расширяет ничьих прав, человек каждое действие видел.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { sweepApprovedInitiatives } from '@/lib/agents/kernel/adapters/initiative-tasks';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 минут — может быть много инициатив

async function notifyOwner(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_OWNER_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
  } catch {
    /* silent */
  }
}

/**
 * Браузер прислал Origin, и он не совпадает с хостом запроса — чужая
 * страница пытается нажать ручку cookie-сессией владельца. Отсутствующий
 * Origin не блокируем: его нет у curl и части same-origin запросов.
 */
function crossOrigin(req: NextRequest): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).host !== req.nextUrl.host;
  } catch {
    return true;
  }
}

// GET ничего не меняет: только статистика (?stats=1). Исполнение — POST ниже.
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const hours = parseInt(req.nextUrl.searchParams.get('hours') ?? '12', 10);
  const statsOnly = req.nextUrl.searchParams.get('stats') === '1';

  if (!statsOnly) {
    return NextResponse.json(
      { error: 'Исполнение — только POST. GET отвечает статистикой: ?stats=1' },
      { status: 405 },
    );
  }

  {
    try {
      const [meetingsRes, approvalsRes] = await Promise.all([
        pool.query(
          `SELECT
             COUNT(*) FILTER (WHERE status = 'completed') AS completed,
             COUNT(*) FILTER (WHERE status = 'running')   AS running,
             COUNT(*) AS total,
             MIN(started_at) AS first_at,
             MAX(started_at) AS last_at
           FROM board_meeting_sessions
           WHERE started_at > NOW() - ($1 || ' hours')::interval`,
          [hours]
        ),
        pool.query(
          `SELECT status, COUNT(*) as cnt
           FROM agent_approvals
           GROUP BY status`
        ),
      ]);
      const meetings = meetingsRes.rows[0];
      const approvals: Record<string, number> = {};
      for (const r of approvalsRes.rows) {
        approvals[r.status] = parseInt(r.cnt);
      }
      return NextResponse.json({
        period_hours: hours,
        meetings: {
          total:     parseInt(meetings.total),
          completed: parseInt(meetings.completed),
          running:   parseInt(meetings.running),
          first_at:  meetings.first_at,
          last_at:   meetings.last_at,
        },
        approvals,
      });
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
    }
  }
}

export async function POST(req: NextRequest) {
  // Admin-JWT, не CRON_SECRET: ручка исполняет реальные мутации, и право на
  // неё — у владельца, а не у всякого, кто знает секрет кронов (см. шапку).
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  if (crossOrigin(req)) {
    return NextResponse.json({ error: 'Origin не совпадает с хостом — запрос отклонён' }, { status: 403 });
  }

  const hours = parseInt(req.nextUrl.searchParams.get('hours') ?? '12', 10);
  const log: string[] = [];

  // ── STEP 1: AUTO-MIGRATE ──────────────────────────────────────────────────
  try {
    await pool.query(`
      ALTER TABLE agent_approvals
        ADD COLUMN IF NOT EXISTS executor_agent_id VARCHAR(50),
        ADD COLUMN IF NOT EXISTS executor_name     VARCHAR(100),
        ADD COLUMN IF NOT EXISTS execution_status  VARCHAR(20)
          CHECK (execution_status IN ('assigned','in_progress','done','failed')),
        ADD COLUMN IF NOT EXISTS approved_at       TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS due_date          DATE;

      CREATE INDEX IF NOT EXISTS idx_agent_approvals_execution
        ON agent_approvals(execution_status, executor_agent_id)
        WHERE execution_status = 'assigned';
    `);
    log.push('migration: columns added/verified OK');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.push(`migration warning: ${msg}`);
    // Продолжаем — колонки могут уже существовать
  }

  // ── STEP 2: BACKFILL — старые approved без execution_status ──────────────
  try {
    const backfillResult = await pool.query(`
      UPDATE agent_approvals
      SET execution_status = 'assigned',
          approved_at = COALESCE(reviewed_at, NOW())
      WHERE status = 'approved'
        AND (execution_status IS NULL OR execution_status = '' OR execution_status = 'pending')
      RETURNING id
    `);
    log.push(`backfill: ${backfillResult.rowCount} old approved → assigned`);
  } catch (err) {
    log.push(`backfill error: ${err instanceof Error ? err.message : String(err)}`);
  }

  // FORCE-режима больше нет (27.08). Прежний ?force=1 одобрял ВСЕ pending
  // одним запросом — обход поштучного ревью, ради которого очередь
  // agent_approvals и существует. Одобрение — только поштучно: Telegram
  // (/approve_*) или админка. Батч здесь исполняет исключительно то, что
  // человек уже одобрил.

  // ── STEP 3: ENQUEUE В ЯДРО (модель автономии 27.08) ──────────────────────
  // execute-all больше НЕ исполняет инициативы inline: он ставит одобренные
  // человеком (status='approved') в очередь Volcano OS. Policy ядра решает
  // allow/deny поимённо (initiative.<action_type>), эффект исполняет
  // kernel worker (/api/cron/kernel-worker) с pre_commit-проверкой.
  // Дедуп держит идемпотентность ядра (ключ initiative:<id>) — повторный
  // вызов ничего не задваивает по построению.
  try {
    const sweep = await sweepApprovedInitiatives({ type: 'admin', id: String(auth.userId ?? 'panel') }, hours);
    const counts = { enqueued: 0, already_active: 0, already_done: 0, rejected: 0 };
    for (const o of sweep.outcomes) counts[o.outcome] += 1;
    log.push(`sweep: ${sweep.scanned} approved → enqueued ${counts.enqueued}, active ${counts.already_active}, done ${counts.already_done}, rejected ${counts.rejected}`);

    const rejectedDetails = sweep.outcomes
      .filter((o): o is Extract<typeof o, { outcome: 'rejected' }> => o.outcome === 'rejected')
      .map(o => `• ${o.taskId.slice(0, 8)}: ${o.reason}`);

    await notifyOwner(
      `<b>Volcano OS: инициативы поставлены в очередь</b>\n` +
      `Просмотрено: ${sweep.scanned} | В очередь: ${counts.enqueued} | Уже в работе: ${counts.already_active}\n` +
      `Уже исполнено: ${counts.already_done} | Отклонено policy: ${counts.rejected}` +
      (rejectedDetails.length ? `\n${rejectedDetails.join('\n')}` : '') +
      `\nИсполнит kernel worker; итоги — в панели Volcano OS.`
    );

    return NextResponse.json({
      success: true,
      scanned: sweep.scanned,
      ...counts,
      outcomes: sweep.outcomes,
      hours_window: hours,
      log,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg, log }, { status: 500 });
  }
}
