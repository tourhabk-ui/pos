import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const authError = await requireAdmin(request);
  if (authError instanceof NextResponse) return authError;

  try {
    const [issuesResult, logResult] = await Promise.all([
      pool.query<{
        id: string; category: string; severity: string; file_path: string | null;
        title: string; description: string | null; suggestion: string | null;
        status: string; created_at: string;
      }>(
        `SELECT id, category, severity, file_path, title, description, suggestion, status, created_at
         FROM evo_growth_issues
         WHERE status IN ('open', 'suggested')
         ORDER BY
           CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
           created_at ASC
         LIMIT 100`,
      ),
      pool.query<{
        id: string; issue_id: string | null; action: string; status: string;
        diff_summary: string | null; created_at: string;
        issue_title: string | null; issue_file: string | null;
      }>(
        `SELECT l.id, l.issue_id, l.action, l.status, l.diff_summary, l.created_at,
                i.title AS issue_title, i.file_path AS issue_file
         FROM evo_evolution_log l
         LEFT JOIN evo_growth_issues i ON i.id = l.issue_id
         WHERE l.status = 'pending'
         ORDER BY l.created_at DESC
         LIMIT 30`,
      ),
    ]);

    return NextResponse.json({ issues: issuesResult.rows, log: logResult.rows });
  } catch {
    return NextResponse.json({ issues: [], log: [] });
  }
}

const PatchSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('issue'),
    id: z.string().uuid(),
    status: z.enum(['rejected', 'ignored', 'accepted']),
  }),
  z.object({
    kind: z.literal('log'),
    id: z.string().uuid(),
    status: z.enum(['merged', 'rejected']),
  }),
]);

export async function PATCH(request: NextRequest) {
  const authError = await requireAdmin(request);
  if (authError instanceof NextResponse) return authError;

  const body = await request.json().catch(() => null);
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Некорректные данные' }, { status: 400 });
  }

  try {
    if (parsed.data.kind === 'issue') {
      await pool.query(
        `UPDATE evo_growth_issues SET status = $1 WHERE id = $2`,
        [parsed.data.status, parsed.data.id],
      );
    } else {
      await pool.query(
        `UPDATE evo_evolution_log SET status = $1 WHERE id = $2`,
        [parsed.data.status, parsed.data.id],
      );
    }
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'Ошибка обновления' }, { status: 500 });
  }
}
