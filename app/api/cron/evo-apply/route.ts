/**
 * Рука действия эволюции — интерфейс для GitHub Actions раннера
 * (scripts/evo-apply.js). Раннер живёт на GitHub (не на Timeweb), поэтому
 * RF-блокировки его не касаются: он читает отсюда pending-правки, применяет
 * детерминированно и открывает ЧЕРНОВОЙ PR.
 *
 * GET  /api/cron/evo-apply?secret=<CRON_SECRET>
 *   → список pending детерминированных правок (add_index / delete_file).
 *     Старые записи с сырым AI-диффом (не JSON) отфильтровываются.
 *
 * POST /api/cron/evo-apply?secret=<CRON_SECRET>
 *   body { shipped: [{ id, pr_url }] }
 *   → помечает записи как 'in_progress' с ссылкой на открытый PR, чтобы
 *     следующий прогон не применял их повторно. Финальный 'merged' проставит
 *     человек через фидбек после мержа.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { verifyCronSecret } from '@/lib/auth/cron';
import { parseFixPayload } from '@/lib/agents/evo/deterministic-fix';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { rows } = await pool.query<{
    id: string;
    action: string;
    diff_summary: string | null;
    issue_title: string | null;
    category: string | null;
    severity: string | null;
  }>(`
    SELECT el.id, el.action, el.diff_summary,
           gi.title AS issue_title, gi.category, gi.severity
    FROM evo_evolution_log el
    LEFT JOIN evo_growth_issues gi ON gi.id = el.issue_id
    WHERE el.status = 'pending'
    ORDER BY el.created_at ASC
    LIMIT 50
  `);

  const fixes = rows
    .map((r) => {
      const payload = parseFixPayload(r.diff_summary);
      if (!payload) return null; // не детерминированная/битая запись — раннер не трогает
      return {
        id: r.id,
        action: r.action,
        category: r.category,
        severity: r.severity,
        title: r.issue_title,
        fix: payload,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  return NextResponse.json({ success: true, count: fixes.length, fixes });
}

const ShippedSchema = z.object({
  // Записи, вошедшие в открытый черновой PR.
  shipped: z
    .array(z.object({ id: z.string().uuid(), pr_url: z.string().url().max(500) }))
    .max(50)
    .optional()
    .default([]),
  // Записи, которые уже были применены ранее (индекс/файл на месте) —
  // закрываем без PR, чтобы не висели в pending вечно.
  noop: z.array(z.string().uuid()).max(50).optional().default([]),
});

export async function POST(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = ShippedSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'shipped[] required' },
      { status: 400 },
    );
  }

  let updated = 0;
  for (const item of parsed.data.shipped) {
    // Только из 'pending' → 'in_progress': не перетираем уже слитые/отклонённые.
    const res = await pool.query(
      `UPDATE evo_evolution_log
         SET status = 'in_progress', pr_url = $2, resolved_at = NOW()
       WHERE id = $1 AND status = 'pending'`,
      [item.id, item.pr_url],
    );
    updated += res.rowCount ?? 0;
  }

  let closedNoop = 0;
  for (const id of parsed.data.noop) {
    // Уже применено ранее — закрываем без PR, чтобы не висело в pending.
    const res = await pool.query(
      `UPDATE evo_evolution_log
         SET status = 'complete', resolved_at = NOW(),
             review_notes = 'no-op: правка уже присутствовала в репозитории'
       WHERE id = $1 AND status = 'pending'`,
      [id],
    );
    closedNoop += res.rowCount ?? 0;
  }

  return NextResponse.json({ success: true, updated, closed_noop: closedNoop });
}
