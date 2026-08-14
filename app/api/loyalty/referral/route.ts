import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/auth/jwt';
import { loyaltySystem } from '@/lib/loyalty/loyalty-system';
import { getPublicBaseUrl } from '@/lib/config';
import { withReferral } from '@/lib/referral/link';

export const dynamic = 'force-dynamic';

/**
 * GET /api/loyalty/referral — получить свой реферальный код и статистику
 */
export async function GET(request: NextRequest) {
  try {
    const user = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Требуется авторизация' }, { status: 401 });
    }

    const stats = await loyaltySystem.getUserLoyaltyStats(user.userId);

    return NextResponse.json({
      success: true,
      data: {
        code: stats.referral.code,
        shareUrl: stats.referral.code ? withReferral(getPublicBaseUrl(), stats.referral.code) : null,
        stats: {
          invited: stats.referral.invited,
          completed: stats.referral.completed,
          totalEarned: stats.referral.totalEarned,
        },
      },
    });
  } catch {
    return NextResponse.json({ success: false, error: 'Ошибка загрузки реферальных данных' }, { status: 500 });
  }
}

/**
 * POST /api/loyalty/referral — сгенерировать реферальный код
 */
export async function POST(request: NextRequest) {
  try {
    const user = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Требуется авторизация' }, { status: 401 });
    }

    const code = await loyaltySystem.generateReferralCode(user.userId);

    return NextResponse.json({
      success: true,
      data: {
        code,
        shareUrl: withReferral(getPublicBaseUrl(), code),
      },
    });
  } catch {
    return NextResponse.json({ success: false, error: 'Ошибка генерации кода' }, { status: 500 });
  }
}
