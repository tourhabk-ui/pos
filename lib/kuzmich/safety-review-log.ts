/**
 * lib/kuzmich/safety-review-log.ts — журнал утверждений Кузьмича о
 * безопасности для разбора человеком (#2300, миграция 1188).
 *
 * Пишется ответ, где сверка нашла хоть одно утверждение о безопасности (любой
 * вердикт, кроме «утверждений нет»): разбирать надо и верные, иначе разбор
 * видит только тревоги сторожа и не знает, сколько он пропустил.
 *
 * Хранится отрывок ОТВЕТА после redactPII; вопрос туриста и номер чата — нет
 * (pd-guard). Отказ записи не роняет ответ туристу и не глушится: имя
 * проверки и SQLSTATE — в лог (§4.0).
 */

import { pool } from '@/lib/db-pool';
import { redactPII } from '@/lib/security/pii-redact';
import type { ToolRun } from '@/lib/agents/eval/grounding';
import type { GuardResult } from './safety-claim-guard';

export type ReviewSurface = 'telegram' | 'max' | 'other' | 'web' | 'web-stream';

const EXCERPT_MAX = 1500;

export async function recordSafetyReview(
  surface: ReviewSurface, guard: GuardResult, toolRuns: readonly ToolRun[] | null,
): Promise<void> {
  if (guard.verdict === 'none') return;
  try {
    await pool.query(`DELETE FROM kuzmich_safety_reviews WHERE created_at < NOW() - INTERVAL '30 days'`);
    await pool.query(
      `INSERT INTO kuzmich_safety_reviews (surface, verdict, claims, flagged, tools, reply_excerpt)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::text[], $6)`,
      [
        surface, guard.verdict,
        JSON.stringify(guard.claims), JSON.stringify(guard.flagged),
        [...new Set((toolRuns ?? []).map((r) => r.name))],
        redactPII(guard.text).slice(0, EXCERPT_MAX),
      ],
    );
  } catch (err) {
    const e = err as { code?: string; message?: string };
    console.error('[kuzmich-safety-review] запись разбора не сделана', { sqlstate: e?.code, message: e?.message });
  }
}
