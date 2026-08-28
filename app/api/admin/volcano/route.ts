/**
 * GET /api/admin/volcano
 *
 * Volcano OS Cockpit (P3, задача владельца 27.08) — ТОЛЬКО ПРОСМОТР.
 *
 * Владелец до этого роута не видел систему вовсе: agent_tasks/agent_events
 * читались только psql-ом, и «жива ли автономия» выяснялось вопросом к
 * кодировщику. Роут отдаёт три уровня одной выборкой:
 *  - сводка: активные задачи, за сутки, отказы policy, последний прогон Evo;
 *  - «Ждут моего решения»: awaiting_merge задачи с прямой ссылкой на PR —
 *    единственное место, где от человека требуется действие (merge/reject
 *    в GitHub, не здесь);
 *  - лента: последние задачи и события ядра.
 *
 * ?task_id=<uuid> — карточка одной задачи: строка + ПОЛНАЯ цепочка её событий
 * по seq (кто, что, какие стадии, сколько шло) + задачи того же trace.
 *
 * Мутаций здесь НЕТ по построению: ни одной кнопки действия у панели нет,
 * merge делает человек в GitHub, задачи двигает kernel. Сторож:
 * tests/unit/volcano-cockpit.test.ts.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

interface TaskRow {
  id: string;
  parent_task_id: string | null;
  trace_id: string;
  principal: string;
  capability: string;
  resource_type: string | null;
  resource_id: string | null;
  risk: string;
  state: string;
  attempt: number;
  summary: string | null;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  id: string;
  task_id: string;
  trace_id: string;
  seq: number;
  event_type: string;
  from_state: string | null;
  to_state: string | null;
  actor: string;
  details: Record<string, unknown>;
  created_at: string;
}

const TASK_COLS = `id, parent_task_id, trace_id, principal, capability,
  resource_type, resource_id, risk, state, attempt, summary,
  created_at::text, updated_at::text`;

const EVENT_COLS = `id::text, task_id, trace_id, seq, event_type,
  from_state, to_state, actor, details, created_at::text`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest) {
  const authError = await requireAdmin(request);
  if (authError instanceof NextResponse) return authError;

  const taskId = request.nextUrl.searchParams.get('task_id');

  try {
    // ── Карточка одной задачи ────────────────────────────────────────────
    if (taskId) {
      if (!UUID_RE.test(taskId)) {
        return NextResponse.json({ error: 'task_id не UUID' }, { status: 400 });
      }
      const { rows: tasks } = await pool.query<TaskRow>(
        `SELECT ${TASK_COLS} FROM agent_tasks WHERE id = $1`,
        [taskId],
      );
      const task = tasks[0];
      if (!task) {
        return NextResponse.json({ error: 'Задача не найдена' }, { status: 404 });
      }
      const { rows: events } = await pool.query<EventRow>(
        `SELECT ${EVENT_COLS} FROM agent_events WHERE task_id = $1 ORDER BY seq ASC`,
        [taskId],
      );
      // Задачи того же trace — связь инициатива → PR видна без поиска руками.
      const { rows: traceTasks } = await pool.query<TaskRow>(
        `SELECT ${TASK_COLS} FROM agent_tasks
         WHERE trace_id = $1 AND id <> $2
         ORDER BY created_at ASC`,
        [task.trace_id, taskId],
      );
      return NextResponse.json({ task, events, trace_tasks: traceTasks });
    }

    // ── Обзор ────────────────────────────────────────────────────────────
    const [byState, last24, denied24, awaiting, lastEvo, tasks, events] = await Promise.all([
      pool.query<{ state: string; count: string }>(
        `SELECT state, COUNT(*)::text AS count FROM agent_tasks GROUP BY state`,
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM agent_tasks
         WHERE created_at >= NOW() - interval '24 hours'`,
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM agent_events
         WHERE event_type = 'policy_denied'
           AND created_at >= NOW() - interval '24 hours'`,
      ),
      pool.query<TaskRow>(
        `SELECT ${TASK_COLS} FROM agent_tasks
         WHERE state = 'awaiting_merge'
         ORDER BY updated_at DESC
         LIMIT 20`,
      ),
      pool.query<TaskRow>(
        `SELECT ${TASK_COLS} FROM agent_tasks
         WHERE capability = 'evo.run'
         ORDER BY created_at DESC
         LIMIT 1`,
      ),
      pool.query<TaskRow>(
        `SELECT ${TASK_COLS} FROM agent_tasks
         ORDER BY updated_at DESC
         LIMIT 30`,
      ),
      pool.query<EventRow>(
        `SELECT ${EVENT_COLS} FROM agent_events
         ORDER BY id DESC
         LIMIT 50`,
      ),
    ]);

    const states: Record<string, number> = {};
    for (const r of byState.rows) states[r.state] = parseInt(r.count, 10);
    const active =
      (states.queued ?? 0) + (states.running ?? 0) + (states.awaiting_merge ?? 0) +
      (states.proposed ?? 0) + (states.awaiting_approval ?? 0);

    return NextResponse.json({
      summary: {
        states,
        active,
        created_24h: parseInt(last24.rows[0]?.count ?? '0', 10),
        policy_denied_24h: parseInt(denied24.rows[0]?.count ?? '0', 10),
        awaiting_merge: awaiting.rows.length,
        // null — прогонов Evo через ядро ещё не было; панель обязана
        // показать это как «не было», а не как пустую рамку (§4.0).
        last_evo_run: lastEvo.rows[0] ?? null,
      },
      awaiting_merge: awaiting.rows,
      tasks: tasks.rows,
      events: events.rows,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Ошибка БД' },
      { status: 500 },
    );
  }
}
