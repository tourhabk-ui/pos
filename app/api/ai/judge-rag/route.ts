import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { callAIWaterfall } from '@/lib/ai/providers';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const PostSchema = z.object({
  query:  z.string().min(1).max(500),
  answer: z.string().min(1).max(5000),
});

const JUDGE_SYSTEM = `Ты LLM-судья качества ответов. Оцени ответ по двум критериям от 1 до 5.
Верни JSON строго в формате: {"relevance_score": N, "completeness_score": N, "verdict": "текст"}
Без markdown, без лишних пояснений — только JSON.

Критерии:
- relevance_score 1-5: насколько ответ соответствует вопросу (1=не по теме, 5=точно по теме)
- completeness_score 1-5: насколько ответ полон (1=очень краткий, 5=исчерпывающий)
- verdict: одно предложение с итоговой оценкой`;

/**
 * POST /api/ai/judge-rag
 * Оценивает качество RAG-ответа через LLM-судью.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const body = await req.json().catch(() => null);
  const parsed = PostSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Некорректные данные' },
      { status: 400 },
    );
  }

  const { query, answer } = parsed.data;

  const judgePrompt = `Вопрос: ${query}\n\nОтвет: ${answer}`;

  let judgeRaw: string;
  try {
    judgeRaw = await callAIWaterfall([
      { role: 'system', content: JUDGE_SYSTEM },
      { role: 'user',   content: judgePrompt },
    ]);
  } catch {
    return NextResponse.json({ error: 'AI-судья недоступен' }, { status: 503 });
  }

  let relevance_score: number | null = null;
  let completeness_score: number | null = null;
  let verdict: string | null = null;

  try {
    const clean = judgeRaw.replace(/```json|```/g, '').trim();
    const j = JSON.parse(clean) as Record<string, unknown>;
    relevance_score    = typeof j.relevance_score === 'number'    ? Math.min(5, Math.max(1, Math.round(j.relevance_score)))    : null;
    completeness_score = typeof j.completeness_score === 'number' ? Math.min(5, Math.max(1, Math.round(j.completeness_score))) : null;
    verdict            = typeof j.verdict === 'string' ? j.verdict.slice(0, 500) : null;
  } catch {
    // не смогли распарсить — пишем null-оценки, чтобы не терять запись
  }

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO rag_quality_log
       (query, answer, relevance_score, completeness_score, verdict, model)
     VALUES ($1, $2, $3, $4, $5, 'waterfall')
     RETURNING id`,
    [query, answer, relevance_score, completeness_score, verdict],
  );

  return NextResponse.json({
    id:                rows[0]?.id,
    relevance_score,
    completeness_score,
    verdict,
  });
}

/**
 * GET /api/ai/judge-rag
 * Возвращает средние баллы качества RAG за последние 7 дней.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const { rows } = await pool.query<{
    total_evaluations: string;
    avg_relevance: string | null;
    avg_completeness: string | null;
  }>(
    `SELECT
       COUNT(*)::int                           AS total_evaluations,
       ROUND(AVG(relevance_score)::numeric, 2) AS avg_relevance,
       ROUND(AVG(completeness_score)::numeric, 2) AS avg_completeness
     FROM rag_quality_log
     WHERE created_at >= NOW() - INTERVAL '7 days'`,
    [],
  );

  const row = rows[0];

  return NextResponse.json({
    period_days: 7,
    total_evaluations: Number(row?.total_evaluations ?? 0),
    avg_relevance_score:    row?.avg_relevance    != null ? Number(row.avg_relevance)    : null,
    avg_completeness_score: row?.avg_completeness != null ? Number(row.avg_completeness) : null,
    as_of: new Date().toISOString(),
  });
}
