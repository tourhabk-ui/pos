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
import { verifyAgainstSource } from '@/lib/agents/evo/finding-guard';
import { githubFetch } from '@/lib/agents/evo/github-fetch';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const REPORT_LIMIT = 10; // не заваливаем трекер за один прогон

/** Тело файла из репозитория (для сверки находки с живым кодом). null — не достали. */
async function fetchSource(relPath: string): Promise<string | null> {
  try {
    const res = await githubFetch(
      `https://raw.githubusercontent.com/tourhabk-ui/pos/main/${relPath}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

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

  // Сверка с ЖИВЫМ исходником перед публикацией. Инцидент 24.07: наружу ушли
  // 10 issues про booking-роут — «нет requireAuth/try-catch/FOR UPDATE», хотя в
  // файле есть всё три. Страж стоял только на входе (скан), выход публиковал
  // что лежит в БД, включая до-стражевый мусор. Не прошедшее сверку помечаем
  // 'rejected' — оно больше не всплывёт (БД самоочищается).
  const sourceCache = new Map<string, string | null>();
  const verified: typeof rows = [];
  const rejected: string[] = [];

  for (const f of rows) {
    if (!f.file_path) { verified.push(f); continue; }

    let src = sourceCache.get(f.file_path);
    if (src === undefined) {
      src = await fetchSource(f.file_path);
      sourceCache.set(f.file_path, src);
    }
    // Исходник не достали — не судим (иначе при недоступном GitHub отбросим всё).
    if (src === null) { verified.push(f); continue; }

    const reason = verifyAgainstSource(
      { title: f.title, description: f.description ?? '', suggestion: f.suggestion ?? '' },
      src,
    );
    if (reason) rejected.push(f.id);
    else verified.push(f);
  }

  if (rejected.length > 0) {
    await pool.query(
      `UPDATE evo_growth_issues SET status = 'rejected', resolved_at = NOW() WHERE id = ANY($1::uuid[])`,
      [rejected],
    ).catch(() => { /* чистка некритична для публикации */ });
  }

  const issues = selectReportable(verified, REPORT_LIMIT).map((f) => ({
    id: f.id,
    title: buildIssueTitle(f),
    body: buildIssueBody(f),
    severity: f.severity,
    category: f.category,
  }));

  return NextResponse.json({
    success: true,
    count: issues.length,
    // Видно, сколько мусора отсеяно за прогон — «0 issues» перестаёт быть немым.
    rejected_by_guard: rejected.length,
    issues,
  });
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
