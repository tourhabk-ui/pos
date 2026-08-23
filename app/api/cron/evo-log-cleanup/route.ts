/**
 * GET /api/cron/evo-log-cleanup?secret=<CRON_SECRET>[&apply=1][&limit=N]
 *
 * Чистка неисполнимых записей очереди эволюции (evo_evolution_log).
 *
 * Замер 23.08: 21 запись со статусом `pending` висела с апреля. Их действие —
 * `auto_fix_dead_code` с телом `DELETE FILE: …` — в коде НЕ ВСТРЕЧАЕТСЯ НИ
 * РАЗУ: подсистема, которая их создавала, удалена. Рука эволюции
 * (`/api/cron/evo-apply`) их молча пропускает каждый прогон, потому что
 * `parseFixPayload` возвращает для них null, — и они остаются «ожидающими»
 * навсегда. Из 15 упомянутых файлов 11 давно удалены, а
 * `lib/analytics/lead-tracking.ts` помечен «мёртвым модулем», хотя его
 * импортируют три живых компонента.
 *
 * Вечно висящее «ожидает» — не безобидный мусор: панель показывает работу,
 * которой никто не сделает, и настоящая ожидающая правка тонет среди неё.
 *
 * ПРЕДИКАТ ТОТ ЖЕ, ЧТО У РУКИ. Неисполнима запись ровно тогда, когда её
 * пропускает `parseFixPayload` — та самая функция, которой пользуется
 * `evo-apply`. Свой список «плохих действий» здесь заводить НЕЛЬЗЯ: две
 * копии правила разойдутся, и чистка начнёт убирать то, что рука ещё умеет.
 *
 * Сухой прогон по умолчанию, партия ограничена, причина пишется в
 * review_notes — запись не исчезает, а получает объяснение.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { verifyCronSecret } from '@/lib/auth/cron';
import { parseFixPayload } from '@/lib/agents/evo/deterministic-fix';

export const dynamic = 'force-dynamic';

/** Потолок партии: чистка — правка данных, и делать её всю разом незачем. */
const MAX_BATCH = 100;

interface LogRow {
  id: string;
  action: string;
  diff_summary: string | null;
  created_at: string;
}

export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const apply = url.searchParams.get('apply') === '1';
  const limit = Math.min(
    Math.max(Number(url.searchParams.get('limit') ?? 50) || 50, 1),
    MAX_BATCH,
  );

  let rows: LogRow[];
  try {
    const res = await pool.query<LogRow>(
      `SELECT id, action, diff_summary, created_at::text
         FROM evo_evolution_log
        WHERE status = 'pending'
        ORDER BY created_at ASC
        LIMIT $1`,
      [limit],
    );
    rows = res.rows;
  } catch (err) {
    // Отказ чтения — третий исход, а не «мусора нет» (§4.0 CLAUDE.md).
    const code = (err as { code?: string }).code ?? 'без SQLSTATE';
    console.error(`[evo-log-cleanup] очередь не прочитана: SQLSTATE ${code}`);
    return NextResponse.json(
      { ok: false, reason: `очередь не прочитана: SQLSTATE ${code}` },
      { status: 503 },
    );
  }

  // Рука применит запись только если payload разбирается. Всё прочее она
  // пропускает — значит эти записи неисполнимы по определению самой руки.
  const unexecutable = rows.filter((r) => parseFixPayload(r.diff_summary) === null);
  const executable = rows.length - unexecutable.length;

  if (!apply) {
    return NextResponse.json({
      ok: true,
      dry_run: true,
      pending_seen: rows.length,
      executable,
      unexecutable: unexecutable.length,
      sample: unexecutable.slice(0, 10).map((r) => ({
        id: r.id,
        action: r.action,
        created_at: r.created_at,
        summary: (r.diff_summary ?? '').slice(0, 80),
      })),
      note: 'Сухой прогон. Чтобы пометить — добавьте &apply=1.',
    });
  }

  if (unexecutable.length === 0) {
    return NextResponse.json({ ok: true, dry_run: false, marked: 0, pending_seen: rows.length });
  }

  try {
    const res = await pool.query(
      `UPDATE evo_evolution_log
          SET status = 'stale',
              resolved_at = NOW(),
              review_notes = COALESCE(review_notes || E'\\n', '') ||
                'Неисполнима: рука эволюции пропускает эту запись (payload не разбирается). '
                || 'Помечено чисткой /api/cron/evo-log-cleanup.'
        WHERE id = ANY($1::uuid[]) AND status = 'pending'`,
      [unexecutable.map((r) => r.id)],
    );
    return NextResponse.json({
      ok: true,
      dry_run: false,
      pending_seen: rows.length,
      executable,
      marked: res.rowCount ?? 0,
    });
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'без SQLSTATE';
    console.error(`[evo-log-cleanup] пометка не выполнена: SQLSTATE ${code}`);
    return NextResponse.json(
      { ok: false, reason: `пометка не выполнена: SQLSTATE ${code}` },
      { status: 503 },
    );
  }
}
