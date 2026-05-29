/**
 * GET /api/admin/audit-rag
 *
 * Scans agent_knowledge for prompt-injection patterns.
 * Returns flagged entries with preview and pattern details.
 * Auth: admin only.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { detectInjection } from '@/lib/security/rag-sanitize';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const authResult = await requireAdmin(req);
  if (authResult instanceof NextResponse) return authResult;

  const { rows } = await pool.query<{
    id: string;
    slug: string;
    type: string;
    title: string;
    compiled_truth: string;
    agent_id: string | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, slug, type, title, compiled_truth, agent_id, created_at, updated_at
     FROM agent_knowledge
     ORDER BY updated_at DESC`
  );

  const flagged: Array<{
    id: string;
    slug: string;
    type: string;
    title: string;
    agent_id: string | null;
    preview: string;
    patterns: string[];
    updated_at: Date;
  }> = [];

  for (const row of rows) {
    const titlePatterns = detectInjection(row.title);
    const contentPatterns = detectInjection(row.compiled_truth);
    const allPatterns = [...new Set([...titlePatterns, ...contentPatterns])];

    if (allPatterns.length > 0) {
      flagged.push({
        id: row.id,
        slug: row.slug,
        type: row.type,
        title: row.title,
        agent_id: row.agent_id,
        preview: row.compiled_truth.slice(0, 300),
        patterns: allPatterns,
        updated_at: row.updated_at,
      });
    }
  }

  return NextResponse.json({
    success: true,
    scanned: rows.length,
    flagged: flagged.length,
    entries: flagged,
  });
}

export async function DELETE(req: NextRequest) {
  const authResult = await requireAdmin(req);
  if (authResult instanceof NextResponse) return authResult;

  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) {
    return NextResponse.json({ error: 'Некорректный id' }, { status: 400 });
  }

  const { rowCount } = await pool.query(
    `DELETE FROM agent_knowledge WHERE id = $1`,
    [id]
  );

  if (!rowCount) {
    return NextResponse.json({ error: 'Запись не найдена' }, { status: 404 });
  }

  return NextResponse.json({ success: true, message: 'Запись удалена' });
}
