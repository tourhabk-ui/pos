/**
 * GET /api/cron/evo-review-job
 *
 * Отдаёт СПИСОК файлов на AI-ревью — не тела файлов. Раннер GitHub
 * (scripts/evo-review.ts, .github/workflows/evo-review.yml) читает
 * содержимое из своего же checkout: он не в РФ, у него нет гео-блока
 * Cloudflare, а прод — есть (§8, замена решателя, вслед за evo-judge.yml,
 * который тем же приёмом уже год разбирает находки с раннера).
 *
 * Выбор файлов остаётся на проде намеренно: он читает леджер покрытия
 * (evo_coverage, через `pool`) — а `pool` с раннера недостижим
 * (lib/db-pool.ts резолвит хост во внутренний IP Timeweb). Раннер получает
 * ГОТОВЫЙ список, не леджер, — так дедуп/churn-логика живёт в одном месте.
 */

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { computeReviewFileList } from '@/lib/agents/evo/growth-agent';
import { loadLearnedLessons, lessonsPromptBlock } from '@/lib/agents/evo/learned-lessons';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { reviewFiles, source, listed } = await computeReviewFileList();
    const learnedLessonsBlock = lessonsPromptBlock(
      await loadLearnedLessons().catch(() => ({ strategy: null, lessons: [], rejectedDigest: [] })),
    );
    return NextResponse.json({
      success: true,
      files: reviewFiles,
      learned_lessons_block: learnedLessonsBlock,
      source,
      listed,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Не удалось собрать список файлов на ревью' },
      { status: 500 },
    );
  }
}
