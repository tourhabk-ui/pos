/**
 * GET  /api/leads/[id]/proposal       — данные предложения
 * POST /api/leads/[id]/proposal/send  — отправить клиенту (Telegram/email)
 * GET  /api/leads/[id]/proposal/pdf   — скачать PDF
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireOperator } from '@/lib/auth/middleware';
import { leadProcessor } from '@/lib/services/operators/lead-processor.service';
import { pool } from '@/lib/db-pool';
import { leadOwnershipCond } from '@/lib/leads/ownership';
import type { JWTPayload } from '@/lib/auth/jwt';

// ── GET /api/leads/[id]/proposal ──────────────────────────────────────────────

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireOperator(req);
  if (authResult instanceof NextResponse) return authResult;
  const user = authResult as JWTPayload;

  const { id } = await params;

  // Владение проверяется здесь же, а не только ролью: чужой лид не читается
  // и неотличим от несуществующего (404, не 403) — та же дисциплина, что
  // в /api/leads/[id] (аудит кабинета оператора нашёл её пропущенной здесь).
  const scope = await leadOwnershipCond(user, 2);
  const { rows } = await pool.query<{ proposal_id: string | null }>(
    `SELECT proposal_id FROM leads WHERE id = $1${scope.cond}`,
    [id, ...scope.vals]
  );

  if (!rows[0]) {
    return NextResponse.json({ error: 'Лид не найден' }, { status: 404 });
  }

  if (!rows[0].proposal_id) {
    return NextResponse.json({ error: 'Предложение ещё не сформировано' }, { status: 404 });
  }

  const proposal = await leadProcessor.getProposal(rows[0].proposal_id);
  if (!proposal) {
    return NextResponse.json({ error: 'Предложение не найдено' }, { status: 404 });
  }

  return NextResponse.json({ proposal });
}
