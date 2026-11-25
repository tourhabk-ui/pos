import { NextRequest, NextResponse } from 'next/server';
import {
  KamchatkaFishingClient,
  transformFishingTour,
} from '@/lib/partners/kamchatka-fishing';
import { requireRole } from '@/lib/auth/middleware';

export const dynamic = 'force-dynamic';

// Только администратор (25.11, скан безопасности): запрос к партнёру идёт с
// ключом ПЛАТФОРМЫ и не фильтруется по вызывающему, а роль оператора любой
// получает сам при регистрации (register-operator). С ролью оператора здесь
// читались все брони «Камчатской рыбалки» с именами, телефонами и почтами
// клиентов и создавались брони от имени Ведара. Так же закрыт соседний
// /api/partners/kamchatka-fishing (25.09).

// GET /api/partners/kamchatka-fishing/tours - Получить туры партнера
export async function GET(request: NextRequest) {
  try {
    const userOrResponse = await requireRole(request, ['admin']);
    if (userOrResponse instanceof NextResponse) return userOrResponse;

    const apiKey = process.env.KAMCHATKA_FISHING_API_KEY;
    const apiSecret = process.env.KAMCHATKA_FISHING_API_SECRET;

    if (!apiKey || !apiSecret) {
      return NextResponse.json({
        success: false,
        error: 'API credentials not configured',
      }, { status: 400 });
    }

    const client = new KamchatkaFishingClient({
      apiKey,
      apiSecret,
    });

    const tours = await client.getTours();
    const transformedTours = tours.map(transformFishingTour);

    return NextResponse.json({
      success: true,
      data: {
        tours: transformedTours,
        count: transformedTours.length,
        source: 'kamchatka-fishing',
      },
    });
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: 'Failed to fetch tours',
      details: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}
