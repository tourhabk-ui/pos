import { safeMsg } from '@/lib/errors/sanitize';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { canReadBooking } from '@/lib/bookings/read-access';
import { query } from '@/lib/database';

export const dynamic = 'force-dynamic';

interface BookingLogRow {
  id: string;
  booking_id: string;
  from_status: string;
  to_status: string;
  changed_by: string;
  changer_name: string | null;
  comment: string | null;
  created_at: string;
}

// GET /api/bookings/[id]/logs — история статусов брони.
// Читают турист брони, агент, который её завёл, оператор тура и админ
// (lib/bookings/read-access.ts). Почта менявшего статус в ответ не
// попадает: читателю она не нужна (pd-guard §2 — лишнее убирается из SELECT).
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const { id: bookingId } = await params;

  const access = await canReadBooking(bookingId, { userId: auth.userId, role: auth.role });
  if (access === 'unknown') {
    return NextResponse.json(
      { success: false, error: 'Не удалось проверить доступ к заявке, попробуйте позже' },
      { status: 503 },
    );
  }
  if (access === 'denied') {
    return NextResponse.json({ success: false, error: 'Заявка не найдена' }, { status: 404 });
  }

  try {
    const result = await query<BookingLogRow>(
      `SELECT bl.id, bl.booking_id, bl.from_status, bl.to_status, bl.changed_by,
              bl.comment, bl.created_at,
              u.name AS changer_name
       FROM booking_logs bl
       LEFT JOIN users u ON bl.changed_by = u.id
       WHERE bl.booking_id = $1::bigint
       ORDER BY bl.created_at ASC`,
      [bookingId]
    );

    return NextResponse.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    const msg = safeMsg(error);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
