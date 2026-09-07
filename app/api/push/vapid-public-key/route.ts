/**
 * GET /api/push/vapid-public-key — публичный ключ VAPID для подписки на push.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ РОУТ. Кнопка «Включить уведомления» читала ключ из
 * NEXT_PUBLIC_VAPID_KEY, а такие переменные вшиваются в клиентский бандл в
 * момент `next build`. Dockerfile ни ARG, ни ENV под ключ не объявляет, и
 * доходит ли переменная панели Timeweb до сборки — неизвестно. Если не
 * доходит, в бандле пустая строка, кнопка считает push «не поддержанным» и
 * НЕ РИСУЕТСЯ ВОВСЕ: владелец 05.09 с установленной PWA не нашёл, где
 * включить уведомления, при VAPID-ключах, которые на сервере заданы (это
 * подтверждал Watchdog). Сервер ключ знает всегда — отсюда роут: клиент
 * спрашивает ключ во время выполнения, а не во время сборки.
 *
 * Ключ публичный по названию и по смыслу: это та же строка, что уезжает в
 * pushManager.subscribe любого браузера. configured=false — честный ответ
 * «на сервере не задано», а не пустая строка, похожая на ключ.
 */
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// AUTH: Public — ключ и так уходит в каждый браузер при подписке.
export async function GET() {
  const key = (process.env.NEXT_PUBLIC_VAPID_KEY ?? '').trim();
  const privateSet = !!(process.env.VAPID_PRIVATE_KEY ?? '').trim();
  return NextResponse.json(
    { key: key || null, configured: !!key && privateSet },
    { headers: { 'Cache-Control': 'public, max-age=300' } },
  );
}
