import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { KamchatkaFishingClient } from '@/lib/partners/kamchatka-fishing';
import { requireRole } from '@/lib/auth/middleware';

export const dynamic = 'force-dynamic';

// Валидация брони (§4): данные клиента уходят внешнему партнёру, а тело
// проверялось только на присутствие полей. Телефон/почта/число участников
// теперь типизированы и ограничены.
const FishingBookingSchema = z.object({
  tourId: z.string().min(1).max(200),
  customerName: z.string().min(1).max(200),
  customerPhone: z.string().min(5).max(30),
  customerEmail: z.string().email().max(200).optional().or(z.literal('')),
  date: z.string().min(1).max(40),
  participants: z.number().int().positive().max(100),
  totalPrice: z.number().nonnegative().finite().optional(),
});

// GET /api/partners/kamchatka-fishing/bookings - Получить бронирования
export async function GET(request: NextRequest) {
  try {
    const userOrResponse = await requireRole(request, ['operator', 'admin']);
    if (userOrResponse instanceof NextResponse) return userOrResponse;

    const apiKey = process.env.KAMCHATKA_FISHING_API_KEY;
    const apiSecret = process.env.KAMCHATKA_FISHING_API_SECRET;

    if (!apiKey || !apiSecret) {
      return NextResponse.json({
        success: false,
        error: 'API credentials not configured',
      }, { status: 400 });
    }

    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status') || undefined;
    const from = searchParams.get('from') || undefined;
    const to = searchParams.get('to') || undefined;

    const client = new KamchatkaFishingClient({
      apiKey,
      apiSecret,
    });

    const bookings = await client.getBookings({ status, from, to });

    return NextResponse.json({
      success: true,
      data: {
        bookings,
        count: bookings.length,
      },
    });
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: 'Failed to fetch bookings',
      details: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}

// POST /api/partners/kamchatka-fishing/bookings - Создать бронирование
export async function POST(request: NextRequest) {
  try {
    const userOrResponse = await requireRole(request, ['operator', 'admin']);
    if (userOrResponse instanceof NextResponse) return userOrResponse;

    const apiKey = process.env.KAMCHATKA_FISHING_API_KEY;
    const apiSecret = process.env.KAMCHATKA_FISHING_API_SECRET;

    if (!apiKey || !apiSecret) {
      return NextResponse.json({
        success: false,
        error: 'API credentials not configured',
      }, { status: 400 });
    }

    let rawBody: unknown;
    try { rawBody = await request.json(); }
    catch { return NextResponse.json({ success: false, error: 'Неверный формат запроса' }, { status: 400 }); }

    const parsed = FishingBookingSchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json({
        success: false,
        error: parsed.error.issues[0]?.message ?? 'Ошибка валидации',
      }, { status: 400 });
    }
    const { tourId, customerName, customerPhone, customerEmail, date, participants, totalPrice } = parsed.data;

    const client = new KamchatkaFishingClient({
      apiKey,
      apiSecret,
    });

    const booking = await client.createBooking({
      tourId,
      customerName,
      customerPhone,
      customerEmail: customerEmail || '',
      date,
      participants,
      totalPrice: totalPrice || 0,
    });

    return NextResponse.json({
      success: true,
      data: booking,
    });
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: 'Failed to create booking',
      details: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}
