/**
 * GET /api/cron/editor-eval?secret=<CRON_SECRET>&limit=12
 *
 * Held-out regression-харнесс для Editor (Roitman §14.8.3): прогоняет генерацию
 * описаний по фиксированному набору (dry-run, без записи) и возвращает TSR + Wilson CI.
 * Для стабильной регрессии задай EDITOR_EVAL_SEED_IDS (через запятую).
 *
 * On-demand (не по расписанию): запускать до/после изменения промпта Editor'а.
 */

import { NextRequest, NextResponse } from 'next/server';
import { runEditorRegression } from '@/lib/agents/eval/editor-regression';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(getCronSecret(request), cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const limitRaw = request.nextUrl.searchParams.get('limit');
  const limit = limitRaw ? Math.min(50, Math.max(1, parseInt(limitRaw, 10) || 12)) : undefined;
  const judge = request.nextUrl.searchParams.get('judge') === '1';

  try {
    const report = await runEditorRegression({ limit, judge });
    return NextResponse.json({ ok: true, timestamp: new Date().toISOString(), ...report });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
