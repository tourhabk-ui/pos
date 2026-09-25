import { NextRequest, NextResponse } from 'next/server';
import {
  KamchatkaFishingClient,
  syncTours,
  getSyncStatus,
} from '@/lib/partners/kamchatka-fishing';
import { requireRole } from '@/lib/auth/middleware';

export const dynamic = 'force-dynamic';

// Только администратор (25.09): это подключение ПЛАТФОРМЫ, а не оператора.
// Раньше его видел и «синхронизировал» каждый оператор, получая в ответ
// «импортировано N туров», хотя syncTours ничего не сохраняет.

// GET /api/partners/kamchatka-fishing - Статус интеграции
export async function GET(request: NextRequest) {
  try {
    const userOrResponse = await requireRole(request, ['admin']);
    if (userOrResponse instanceof NextResponse) return userOrResponse;

    const status = await getSyncStatus();
    
    return NextResponse.json({
      success: true,
      data: {
        partner: {
          id: 'kamchatka-fishing',
          name: 'Камчатская Рыбалка',
          website: 'https://fishingkam.ru',
          type: 'fishing-tours',
        },
        sync: status,
        configured: !!(
          process.env.KAMCHATKA_FISHING_API_KEY && 
          process.env.KAMCHATKA_FISHING_API_SECRET
        ),
      },
    });
  } catch (error) {
    console.error('[partners/kamchatka-fishing] статус не получен:', error instanceof Error ? error.message : error);
    return NextResponse.json({
      success: false,
      error: 'Не удалось получить статус интеграции',
    }, { status: 500 });
  }
}

// POST /api/partners/kamchatka-fishing - Запустить синхронизацию
export async function POST(request: NextRequest) {
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

    // Проверяем подключение
    try {
      await client.healthCheck();
    } catch (healthError) {
      return NextResponse.json({
        success: false,
        error: 'Cannot connect to partner API',
        details: healthError instanceof Error ? healthError.message : 'Unknown error',
      }, { status: 502 });
    }

    // Запускаем синхронизацию
    const result = await syncTours(client);

    return NextResponse.json({
      success: result.success,
      data: result,
    });
  } catch (error) {
    console.error('[partners/kamchatka-fishing] синхронизация упала:', error instanceof Error ? error.message : error);
    return NextResponse.json({
      success: false,
      error: 'Sync failed',
      details: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}
