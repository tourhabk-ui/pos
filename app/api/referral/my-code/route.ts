/**
 * GET /api/referral/my-code — свой код приглашения одной строкой.
 *
 * Зачем отдельный роут, если есть `/api/loyalty/referral`. Тот отдаёт код
 * вместе со всей статистикой лояльности (`getUserLoyaltyStats` — несколько
 * запросов: уровни, траты, эко, рефералы). Кнопке «поделиться» на главной
 * нужен один код, а главная — самая нагруженная страница платформы. Тянуть
 * ради одной строки весь кабинет было бы платой без покупки.
 *
 * Код назначается лениво и идемпотентно: `generateReferralCode` возвращает
 * существующий, если он есть, и заводит новый, если нет. Иначе кнопка отдавала
 * бы обычную ссылку всем, кто ни разу не открывал кабинет лояльности, — то
 * есть почти всем.
 *
 * Гость получает 401. Это не ошибка, а ответ на вопрос «зарегистрирован ли»:
 * кнопка по нему решает, что ссылка обычная.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/auth/jwt';
import { loyaltySystem } from '@/lib/loyalty/loyalty-system';
import { getPublicBaseUrl } from '@/lib/config';
import { withReferral } from '@/lib/referral/link';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const user = await getUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ success: false, error: 'Требуется авторизация' }, { status: 401 });
  }

  try {
    const code = await loyaltySystem.generateReferralCode(user.userId);
    return NextResponse.json({
      success: true,
      data: { code, shareUrl: withReferral(getPublicBaseUrl(), code) },
    });
  } catch {
    return NextResponse.json({ success: false, error: 'Не удалось получить код приглашения' }, { status: 500 });
  }
}
