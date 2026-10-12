/**
 * GET /.well-known/openai-apps-challenge — подтверждение домена для каталога
 * приложений ChatGPT (developers.openai.com/plugins/deploy/submission:
 * «serve the exact token as plain text at
 * https://<host>/.well-known/openai-apps-challenge»).
 *
 * Токен выдаёт портал OpenAI при подаче; здесь он не хранится и не
 * выдумывается — читается из переменной OPENAI_APPS_CHALLENGE_TOKEN на
 * Timeweb. Пока переменной нет, роут отвечает 404 с объяснением: пустая
 * строка или заглушка прошла бы за «подтверждено» у того, кто читает глазами,
 * и не прошла бы у портала (§4.0). Заведён заранее (12.10, «сделай нас
 * видимыми для всех агентов»), чтобы подача не ждала отдельного деплоя.
 */

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export const OPENAI_APPS_CHALLENGE_ENV = 'OPENAI_APPS_CHALLENGE_TOKEN';

export async function GET() {
  const token = (process.env[OPENAI_APPS_CHALLENGE_ENV] ?? '').trim();
  if (!token) {
    return new NextResponse(
      `Токен подтверждения домена для каталога ChatGPT не задан: переменная ${OPENAI_APPS_CHALLENGE_ENV} на Timeweb пуста.`,
      { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } },
    );
  }
  return new NextResponse(token, {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
