/**
 * GET /api/admin/intelligence-feed
 *
 * Список свежих записей памяти разведки (agent_memory, memory_type='intelligence').
 * Возвращает заголовки, summary, action_items, urgency + флаги обработки из value.
 *
 * Query:
 *   ?limit=50  (default 30, max 100)
 *   ?tier=all|active  (default active: tier <= 2)
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

interface IntelligenceRow {
  id: string;
  key: string;
  source: string | null;
  created_at: string;
  updated_at: string;
  memory_tier: number;
  value: {
    domain?: string;
    summary?: string;
    title?: string;
    urgency?: 'low' | 'medium' | 'high' | 'critical' | string;
    severity?: string;
    action_items?: Array<string | { text: string; priority?: string; done?: boolean; sent_to_kiloclaw?: boolean; completed_at?: string }>;
    signal_count?: number;
    processed?: boolean;
    archived?: boolean;
    [k: string]: unknown;
  };
}

export async function GET(request: NextRequest) {
  const authErr = await requireAdmin(request);
  if (authErr instanceof NextResponse) return authErr;

  const url = new URL(request.url);
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') ?? '30', 10) || 30));
  const tierFilter = url.searchParams.get('tier') ?? 'active';
  const unprocessedOnly = url.searchParams.get('unprocessed') === 'true';

  try {
    const tierClause = tierFilter === 'all' ? '' : 'AND memory_tier <= 2';
    const unprocessedClause = unprocessedOnly
      ? `AND (value->>'processed' IS NULL OR value->>'processed' = 'false')`
      : '';

    const { rows } = await pool.query<IntelligenceRow>(`
      SELECT id, key, source, created_at::text, updated_at::text, memory_tier, value
      FROM agent_memory
      WHERE memory_type = 'intelligence'
        ${tierClause}
        ${unprocessedClause}
      ORDER BY created_at DESC
      LIMIT $1
    `, [limit]);

    // Normalize action_items to objects
    const items = rows.map(r => {
      const rawItems = Array.isArray(r.value?.action_items) ? r.value.action_items : [];
      const normalized = rawItems.map((a, i) => {
        if (typeof a === 'string') {
          // Parse inline "[priority] — text" format
          const m = a.match(/^\s*\[([^\]]+)\]\s*[—–-]\s*(.+)$/);
          return {
            idx: i,
            text: m ? m[2].trim() : a.trim(),
            priority: m ? m[1].trim() : 'medium',
            done: false,
            sent_to_kiloclaw: false,
          };
        }
        return {
          idx: i,
          text: a.text ?? '',
          priority: a.priority ?? 'medium',
          done: !!a.done,
          sent_to_kiloclaw: !!a.sent_to_kiloclaw,
          completed_at: a.completed_at,
        };
      });

      return {
        id: r.id,
        key: r.key,
        source: r.source,
        created_at: r.created_at,
        updated_at: r.updated_at,
        tier: r.memory_tier,
        archived: !!r.value?.archived,
        processed: !!r.value?.processed,
        domain: r.value?.domain ?? null,
        summary: r.value?.summary ?? r.value?.title ?? null,
        urgency: r.value?.urgency ?? r.value?.severity ?? 'medium',
        signal_count: r.value?.signal_count ?? null,
        action_items: normalized,
      };
    });

    return NextResponse.json({ success: true, items });
  } catch (err) {
    console.error('[intelligence-feed] GET failed:', err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: 'Ошибка загрузки ленты' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  const authErr = await requireAdmin(request);
  if (authErr instanceof NextResponse) return authErr;

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 });
  }

  const { id, processed } = body as { id?: string; processed?: boolean };
  if (!id || typeof processed !== 'boolean') {
    return NextResponse.json({ error: 'Требуются поля id и processed' }, { status: 400 });
  }
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: 'Некорректный id' }, { status: 400 });
  }

  try {
    const { rowCount } = await pool.query(
      `UPDATE agent_memory
       SET value = value || jsonb_build_object('processed', $1::boolean)
       WHERE id = $2 AND memory_type = 'intelligence'`,
      [processed, id]
    );
    if (!rowCount) {
      return NextResponse.json({ error: 'Запись не найдена' }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[intelligence-feed] PATCH failed:', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Ошибка обновления' }, { status: 500 });
  }
}
