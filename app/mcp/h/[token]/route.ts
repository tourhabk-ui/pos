/**
 * GET /mcp/h/[token] — безопасный переход из MCP-ответа на Ведар
 * (этап 2 плана метрик MCP, чертёж 15.08).
 *
 * Отдельный redirect-endpoint вместо ?mcp_ref= на целевой странице:
 * токен не живёт в финальном URL, истории браузера и share-ссылках.
 * Cookie атрибуции — HttpOnly, подписана сервером; Referrer-Policy
 * no-referrer, чтобы URL с токеном не утёк внешним ресурсам страницы.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  MCP_ATTRIBUTION,
  makeAttributionCookieValue,
  redeemMcpHandoff,
} from '@/lib/mcp/handoff';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params;

  // base64url-токен ожидаемой длины; мусор не отправляем в БД.
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    return new NextResponse('Not found', { status: 404 });
  }

  const handoff = await redeemMcpHandoff(token);
  if (!handoff) {
    return new NextResponse('Ссылка устарела — откройте vedarai.ru', { status: 410 });
  }

  // target_path проверен белым списком при выпуске; redirect только same-origin.
  const destination = new URL(handoff.targetPath, request.nextUrl.origin);
  const response = NextResponse.redirect(destination, { status: 303 });

  // Без MCP_ATTRIBUTION_COOKIE_SECRET переход работает, атрибуция выключена.
  const cookieValue = makeAttributionCookieValue(handoff.handoffId);
  if (cookieValue) {
    response.cookies.set({
      name: MCP_ATTRIBUTION.cookieName,
      value: cookieValue,
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: MCP_ATTRIBUTION.cookieMaxAge,
    });
  }

  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('Cache-Control', 'no-store, private');
  return response;
}
