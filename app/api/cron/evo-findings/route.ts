/**
 * POST /api/cron/evo-findings
 *
 * Принимает ГОТОВЫЕ находки AI-ревью от раннера GitHub (scripts/evo-review.ts,
 * §8: AI-вызов решателя эволюции переехал на раннер — гео-блока Cloudflare
 * там нет, в отличие от прода в РФ). Раннер сам зовёт модель и сам фильтрует
 * ответ (тем же кодом, что и прод-фоллбэк — filterAndMapReviewFindings), сюда
 * приезжает уже проверенный список.
 *
 * Запись — той же функцией (persistGrowthIssues), что и у планового скана:
 * дедуп, кап парафразов на файл, разметка edge/fault_side — одно место,
 * не две расходящиеся копии.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { pool } from '@/lib/db-pool';
import { persistGrowthIssues, loadRejectedSignatures } from '@/lib/agents/evo/growth-agent';
import { dropRejected } from '@/lib/agents/evo/claim-signature';
import { recordReviewed } from '@/lib/agents/evo/coverage-ledger';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const GrowthIssueSchema = z.object({
  category: z.enum(['dead_code', 'security', 'performance', 'bug', 'tech_debt', 'ux', 'compliance', 'funnel']),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  file_path: z.string().optional(),
  line_number: z.number().int().optional(),
  title: z.string().min(1).max(500),
  description: z.string().min(1).max(4000),
  suggestion: z.string().min(1).max(4000),
  model: z.string().max(200).optional(),
  status: z.enum(['open', 'suggested']).optional(),
});

const BodySchema = z.object({
  issues: z.array(GrowthIssueSchema).max(50),
  static_issues: z.array(GrowthIssueSchema).max(50).optional(),
  review_files: z.array(z.string()).max(50),
  model: z.string().max(200).nullable().optional(),
  decision_error: z.string().max(1000).nullable().optional(),
  provenance: z.array(z.string()).max(20).nullable().optional(),
});

export async function POST(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const parsedBody = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsedBody.success) {
    return NextResponse.json({ error: 'Некорректное тело запроса', details: parsedBody.error.flatten() }, { status: 400 });
  }
  const { issues, static_issues = [], review_files, model, decision_error, provenance } = parsedBody.data;

  try {
    const allIssues = [...issues, ...static_issues];

    // Тот же стоп-лист, что у планового скана: не предлагаем то, что человек
    // уже отверг (§4.0 — статус несёт цену, ignored сюда не входит, см.
    // loadRejectedSignatures).
    const rejectedSignatures = await loadRejectedSignatures();
    const kept = dropRejected(allIssues, rejectedSignatures);

    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO evo_growth_scans (scan_type, status, issues_found, duration_ms, summary)
       VALUES ('ai_review_runner', 'complete', $1, 0, $2) RETURNING id`,
      [kept.length, `AI-ревью с раннера GitHub: ${kept.length} находок (модель: ${model ?? 'не ответила'})`],
    );
    const scanId = rows[0]?.id ?? '';

    const newIssues = await persistGrowthIssues(scanId, kept);

    if (review_files.length > 0) {
      const findingsByFile: Record<string, number> = {};
      for (const f of kept) if (f.file_path) findingsByFile[f.file_path] = (findingsByFile[f.file_path] ?? 0) + 1;
      await recordReviewed(pool, findingsByFile, review_files).catch(() => {});
    }

    return NextResponse.json({
      success: true,
      scan_id: scanId,
      received: allIssues.length,
      kept: kept.length,
      new_issues: newIssues,
      model: model ?? null,
      decision_error: decision_error ?? null,
      provenance: provenance ?? null,
    });
  } catch (err) {
    // Отказ записи — не «находок нет», а «не смогли записать» (§4.0):
    // раннер печатает эту ошибку в лог прогона, а не проглатывает.
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Не удалось записать находки AI-ревью' },
      { status: 500 },
    );
  }
}
