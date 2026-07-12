/**
 * GET /api/cron/evo-issues?secret=<CRON_SECRET>[&days=7]
 *
 * READ-ONLY отчёт по открытым проблемам Evo Scan для workflow
 * evo-issues-report.yml (владелец получает алерт «N проблем» в Telegram,
 * а детали — этим отчётом; админ-JWT у раннера нет, CRON_SECRET есть).
 */

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const daysRaw = parseInt(request.nextUrl.searchParams.get('days') ?? '7', 10);
  const days = Math.min(Math.max(Number.isFinite(daysRaw) ? daysRaw : 7, 1), 90);

  try {
    const { rows } = await pool.query<{
      id: string; category: string; severity: string; file_path: string | null;
      line_number: number | null; title: string; description: string | null;
      suggestion: string | null; status: string; created_at: string;
    }>(
      `SELECT id, category, severity, file_path, line_number, title, description,
              suggestion, status, created_at
       FROM evo_growth_issues
       WHERE status IN ('open', 'suggested')
         AND created_at > NOW() - make_interval(days => $1)
       ORDER BY
         CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
         created_at DESC
       LIMIT 100`,
      [days],
    );
    return NextResponse.json({ success: true, days, count: rows.length, issues: rows });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Ошибка отчёта Evo' },
      { status: 500 },
    );
  }
}
