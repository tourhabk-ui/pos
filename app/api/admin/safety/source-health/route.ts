/**
 * GET /api/admin/safety/source-health — видимость здоровья источников safety-ingest.
 *
 * Показывает по каждому каналу МЧС/сейсмо: когда опрашивали, статус, сколько
 * постов дал, когда в последний раз давал данные — и список «мёртвых» (не
 * настроен / давно молчит). Чтобы молчащий канал (напр. MAX-SPA или VK без
 * токена) не прятался. Только админ.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import {
  loadSourceHealth,
  evaluateDeadSources,
  SAFETY_SOURCE_EXPECTATIONS,
} from '@/lib/services/safety/source-health';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const rows = await loadSourceHealth(pool);
    const dead = evaluateDeadSources(rows, SAFETY_SOURCE_EXPECTATIONS, Date.now());
    return NextResponse.json({ success: true, sources: rows, dead, expectations: SAFETY_SOURCE_EXPECTATIONS });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка чтения здоровья источников';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
