/**
 * Рука эволюции → GitHub Issues (интерфейс для GitHub Actions раннера).
 *
 * GET  /api/cron/evo-report?secret=<CRON_SECRET>
 *   → находки Growth Scan в статусе 'suggested', ещё не вынесенные в issue,
 *     с готовыми title/body (детерминированно, без модели). Раннер
 *     (scripts/evo-report-issues.js) заводит по ним GitHub Issues.
 *
 * POST /api/cron/evo-report?secret=<CRON_SECRET>
 *   body { reported: [{ id, issue_url }] }
 *   → проставляет github_issue_url, чтобы следующий прогон не дублировал.
 *
 * Раннер живёт на GitHub (не на Timeweb) → RF-блокировки не мешают gh/API.
 * Никаких изменений кода — только заведение задач в трекер (безопасно, обратимо).
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { verifyCronSecret } from '@/lib/auth/cron';
import { buildIssueTitle, buildIssueBody, selectReportable, type GrowthFinding } from '@/lib/agents/evo/issue-reporter';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const REPORT_LIMIT = 10; // не заваливаем трекер за один прогон

export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { rows } = await pool.query<GrowthFinding & { status: string }>(`
    SELECT id, category, severity, file_path, line_number, title, description, suggestion, status
    FROM evo_growth_issues
    WHERE status = 'suggested'
      AND github_issue_url IS NULL
      AND severity <> 'low'
    ORDER BY
      CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
      created_at ASC
    LIMIT 50
  `);

  const issues = selectReportable(rows, REPORT_LIMIT).map((f) => ({
    id: f.id,
    title: buildIssueTitle(f),
    body: buildIssueBody(f),
    severity: f.severity,
    category: f.category,
  }));

  return NextResponse.json({ success: true, count: issues.length, issues });
}

const ReportedSchema = z.object({
  reported: z
    .array(z.object({ id: z.string().uuid(), issue_url: z.string().url().max(500) }))
    .max(50)
    .optional()
    .default([]),
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

  const parsed = ReportedSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'reported[] required' },
      { status: 400 },
    );
  }

  let updated = 0;
  for (const item of parsed.data.reported) {
    // Только если ещё не помечено — не перетираем ссылку от предыдущего прогона.
    const res = await pool.query(
      `UPDATE evo_growth_issues
         SET github_issue_url = $2
       WHERE id = $1 AND github_issue_url IS NULL`,
      [item.id, item.issue_url],
    );
    updated += res.rowCount ?? 0;
  }

  return NextResponse.json({ success: true, updated });
}
