/**
 * GET /api/admin/evo — статистика Evo System
 * POST /api/admin/evo/feedback — фидбек на эволюционное изменение
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { submitFeedback, getEvoStats } from '@/lib/agents/evo/feedback-loop';
import { runRescueScan } from '@/lib/agents/evo/rescue-agent';
import { z } from 'zod';

const FeedbackSchema = z.object({
  evolution_id: z.string().min(1).max(100),
  outcome: z.enum(['success', 'partial', 'failure', 'regression']),
  impact_score: z.number().finite().optional(),
  human_notes: z.string().max(2000).optional(),
});

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const stats = await getEvoStats();

  // Также вернём текущий статус спасателя (quick check)
  const action = req.nextUrl.searchParams.get('action');
  if (action === 'rescue-scan') {
    const rescue = await runRescueScan();
    return NextResponse.json({ success: true, data: { ...stats, rescue } });
  }

  return NextResponse.json({ success: true, data: stats });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = FeedbackSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'evolution_id and outcome required' }, { status: 400 });
  }

  const result = await submitFeedback({
    evolution_id: parsed.data.evolution_id,
    outcome: parsed.data.outcome,
    impact_score: parsed.data.impact_score ?? 0,
    human_notes: parsed.data.human_notes ?? '',
  });

  return NextResponse.json({ success: true, data: result });
}
