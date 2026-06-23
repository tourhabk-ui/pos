/**
 * POST /api/ai/judge-rag
 *
 * LLM-судья для оценки качества RAG-ответов.
 * Принимает вопрос + ответ бота + контекст из RAG.
 * Возвращает score (0.0–1.0) и причину.
 * Сохраняет результат в ai_actions_log для мониторинга деградации.
 *
 * Auth: requireAuth — вызывается из Kuzmich/chat pipeline
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { callAIFast } from '@/lib/ai/providers';
import { z } from 'zod';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const BodySchema = z.object({
  question: z.string().min(1).max(2000),
  answer: z.string().min(1).max(5000),
  context: z.string().max(4000).optional(),
});

const JUDGE_PROMPT = `Ты — судья качества RAG-ответов туристической платформы Камчатки.
Оцени ответ бота на вопрос пользователя по трём критериям:
1. Релевантность (ответ по теме вопроса)
2. Точность (ответ опирается на предоставленный контекст, а не выдуман)
3. Полнота (вопрос раскрыт достаточно)

Верни ТОЛЬКО валидный JSON без markdown-обёрток:
{"score": 0.85, "reason": "краткое пояснение 1-2 предложения"}

score: от 0.0 (полностью нерелевантный/ошибочный) до 1.0 (отличный ответ).
Не добавляй ничего кроме JSON.`;

interface JudgeResult {
  score: number;
  reason: string;
}

function parseJudgeResponse(raw: string): JudgeResult | null {
  try {
    const cleaned = raw.trim().replace(/^```(?:json)?|```$/g, '').trim();
    const parsed = JSON.parse(cleaned) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    const score = typeof obj.score === 'number' ? obj.score : parseFloat(String(obj.score ?? ''));
    const reason = typeof obj.reason === 'string' ? obj.reason.slice(0, 500) : '';
    if (isNaN(score) || score < 0 || score > 1) return null;
    return { score: Math.round(score * 100) / 100, reason };
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation error', details: parsed.error.flatten() }, { status: 400 });
  }

  const { question, answer, context } = parsed.data;

  const userMessage = [
    `Вопрос пользователя: ${question}`,
    context ? `Контекст RAG:\n${context}` : 'Контекст RAG: не предоставлен',
    `Ответ бота: ${answer}`,
  ].join('\n\n');

  const t0 = Date.now();
  let judgeResult: JudgeResult | null = null;

  try {
    const raw = await callAIFast([
      { role: 'system', content: JUDGE_PROMPT },
      { role: 'user', content: userMessage },
    ]);
    judgeResult = parseJudgeResponse(raw);
  } catch {
    // Не блокируем pipeline при сбое судьи
  }

  if (!judgeResult) {
    return NextResponse.json({ error: 'Judge failed to produce a valid score' }, { status: 502 });
  }

  // Сохраняем в ai_actions_log для агрегации в /api/health/llm-cost
  pool.query(
    `INSERT INTO ai_actions_log (action_type, metadata)
     VALUES ($1, $2)`,
    [
      'rag_judge',
      JSON.stringify({
        score: judgeResult.score,
        reason: judgeResult.reason,
        question_length: question.length,
        answer_length: answer.length,
        has_context: !!context,
        duration_ms: Date.now() - t0,
      }),
    ],
  ).catch(() => {});

  return NextResponse.json({
    score: judgeResult.score,
    reason: judgeResult.reason,
    duration_ms: Date.now() - t0,
  });
}
