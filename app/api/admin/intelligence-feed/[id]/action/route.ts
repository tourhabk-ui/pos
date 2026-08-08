/**
 * POST /api/admin/intelligence-feed/[id]/action
 *
 * Body: { action: 'toggle_done' | 'archive' | 'unarchive', itemIdx?: number }
 *
 * Мутирует value в agent_memory:
 *   - toggle_done: переключает action_items[itemIdx].done
 *   - archive / unarchive: меняет memory_tier (3 = cold/archived, 2 = warm/active) и value.archived
 *
 * Действие send_to_kiloclaw удалено (владелец 08.08: бот KiloClaw больше не
 * задействован). Реализация находок теперь автоматическая: мост
 * bridgeMonitorFindings → evo_growth_issues('intel') → issue-reporter →
 * GitHub Issues → Claude Code. Поле sent_to_kiloclaw в старых записях —
 * история, его не трогаем.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

type Action = 'toggle_done' | 'archive' | 'unarchive';

interface Body {
  action: Action;
  itemIdx?: number;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authErr = await requireAdmin(request);
  if (authErr instanceof NextResponse) return authErr;

  const { id } = await params;
  const body = await request.json().catch(() => ({})) as Body;
  const action = body.action;

  if (!action) {
    return NextResponse.json({ success: false, error: 'action is required' }, { status: 400 });
  }

  try {
    // Load current value
    const { rows: current } = await pool.query<{ value: Record<string, unknown> }>(
      `SELECT value FROM agent_memory WHERE id = $1 AND memory_type = 'intelligence' LIMIT 1`,
      [id],
    );
    if (current.length === 0) {
      return NextResponse.json({ success: false, error: 'not found' }, { status: 404 });
    }
    const row = current[0];
    const value = { ...(row.value as Record<string, unknown>) };

    if (action === 'archive' || action === 'unarchive') {
      value.archived = action === 'archive';
      const newTier = action === 'archive' ? 3 : 2;
      await pool.query(
        `UPDATE agent_memory SET value = $1, memory_tier = $2, updated_at = NOW() WHERE id = $3`,
        [JSON.stringify(value), newTier, id],
      );
      return NextResponse.json({ success: true, archived: value.archived });
    }

    if (action === 'toggle_done') {
      const idx = body.itemIdx;
      if (typeof idx !== 'number') {
        return NextResponse.json({ success: false, error: 'itemIdx is required' }, { status: 400 });
      }
      const rawItems = Array.isArray(value.action_items) ? value.action_items as unknown[] : [];
      // Normalize string items to object form in-place
      const itemsObj: Record<string, unknown>[] = rawItems.map(a => {
        if (typeof a === 'string') {
          const m = a.match(/^\s*\[([^\]]+)\]\s*[—–-]\s*(.+)$/);
          return m
            ? { text: m[2].trim(), priority: m[1].trim(), done: false }
            : { text: a.trim(), priority: 'medium', done: false };
        }
        return { ...(a as Record<string, unknown>) };
      });
      if (idx < 0 || idx >= itemsObj.length) {
        return NextResponse.json({ success: false, error: 'itemIdx out of range' }, { status: 400 });
      }
      const cur = itemsObj[idx];
      cur.done = !cur.done;
      if (cur.done) cur.completed_at = new Date().toISOString();
      else delete cur.completed_at;
      value.action_items = itemsObj;
      await pool.query(
        `UPDATE agent_memory SET value = $1, updated_at = NOW() WHERE id = $2`,
        [JSON.stringify(value), id],
      );
      return NextResponse.json({ success: true, done: itemsObj[idx].done });
    }

    return NextResponse.json({ success: false, error: `unknown action: ${action}` }, { status: 400 });
  } catch (err) {
    console.error('[intelligence-feed/action] failed:', err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: 'server error' }, { status: 500 });
  }
}
