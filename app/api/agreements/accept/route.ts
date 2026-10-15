/**
 * POST /api/agreements/accept
 * GET /api/agreements/status
 *
 * Управление пользовательскими согласиями
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { requireAuth } from '@/lib/auth/middleware';
import { getTrustedClientIpOrNull } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

const AcceptAgreementSchema = z.object({
  agreement_type: z.enum(['tos', 'privacy', 'content_consent', 'sos_waiver']),
  document_version: z.number().int().min(1),
  accepted: z.boolean(),
});

// Получить User-Agent и IP с запроса.
// Адрес — доверенным порядком (x-real-ip → cf-connecting-ip → первый элемент
// XFF), а не X-Forwarded-For первым: его пишет сам клиент, и в запись согласия
// уходила вся цепочка со слов клиента (P3-02 аудита 15.10). 'unknown' — как
// и прежде, когда адреса нет вовсе: выдумывать 127.0.0.1 в согласии нельзя.
function getClientInfo(req: NextRequest) {
  const ip = getTrustedClientIpOrNull(req.headers) ?? 'unknown';
  const userAgent = req.headers.get('user-agent') || 'unknown';
  return { ip, userAgent };
}

// ── POST: Принять или отклонить согласие ──────────────────────────────────

export async function POST(req: NextRequest) {
  const authOrResponse = await requireAuth(req);
  if (authOrResponse instanceof NextResponse) return authOrResponse;

  const userId = authOrResponse.userId;
  const { ip, userAgent } = getClientInfo(req);

  try {
    const body = await req.json();
    const parsed = AcceptAgreementSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: 'Invalid agreement data' },
        { status: 400 }
      );
    }

    const { agreement_type, document_version, accepted } = parsed.data;

    // Записать согласие (или отклонение)
    const result = await pool.query(
      `INSERT INTO user_agreements
        (user_id, agreement_type, document_version, status, accepted_at, accepted_ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, agreement_type, document_version)
       DO UPDATE SET
         status = $4,
         accepted_at = $5,
         updated_at = NOW()
       RETURNING *`,
      [
        userId,
        agreement_type,
        document_version,
        accepted ? 'accepted' : 'declined',
        accepted ? new Date() : null,
        ip,
        userAgent,
      ]
    );

    // Логирование в аудит
    await pool.query(
      `INSERT INTO agreement_audit_log
        (user_id, action, agreement_type, document_version, ip_address, user_agent, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        userId,
        accepted ? 'accepted' : 'declined',
        agreement_type,
        document_version,
        ip,
        userAgent,
        JSON.stringify({ reason: body.reason || null }),
      ]
    );

    return NextResponse.json({
      success: true,
      agreement: result.rows[0],
      message: accepted ? 'Согласие принято' : 'Согласие отклонено',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

// ── GET: Получить статус согласий пользователя ────────────────────────────

export async function GET(req: NextRequest) {
  const authOrResponse = await requireAuth(req);
  if (authOrResponse instanceof NextResponse) return authOrResponse;

  const userId = authOrResponse.userId;

  try {
    const { rows } = await pool.query(
      `SELECT
         agreement_type,
         document_version,
         status,
         accepted_at,
         created_at
       FROM user_agreements
       WHERE user_id = $1
       ORDER BY agreement_type, document_version DESC`,
      [userId]
    );

    type AgreementRow = { id: string; document_version: string; document_date: string; agreement_type: string; status: string; accepted_at: string | null; created_at: string };
    // Сгруппировать по типам (только последняя версия каждого типа)
    const grouped: Record<string, AgreementRow> = {};
    (rows as AgreementRow[]).forEach((row) => {
      if (!grouped[row.agreement_type] ||
          grouped[row.agreement_type].document_version < row.document_version) {
        grouped[row.agreement_type] = row;
      }
    });

    return NextResponse.json({
      success: true,
      user_id: userId,
      agreements: grouped,
      summary: {
        tos_accepted: grouped['tos']?.status === 'accepted' || false,
        privacy_accepted: grouped['privacy']?.status === 'accepted' || false,
        all_required_accepted:
          grouped['tos']?.status === 'accepted' &&
          grouped['privacy']?.status === 'accepted',
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
