/**
 * POST /api/telegram/setup-webhook
 * Регистрирует webhook URL в Telegram (одноразовая настройка).
 * AUTH: только admin
 *
 * Telegram будет отправлять POST-запросы на:
 *   https://<APP_URL>/api/telegram/webhook
 *
 * Адрес и секрет ставит одна дверь — setCanonicalWebhook (аудит 15.10).
 * Прежние варианты { bot: 'admin' | 'kuzmich' } и { appUrl } переводили ЭТОГО
 * ЖЕ бота (токен один) на другой обработчик или чужой адрес; теперь адрес один.
 * { bot: 'kuzmich' } по-прежнему ставит команды меню.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { setCanonicalWebhook } from '@/lib/telegram/operator-availability';
import { timingSafeCompare } from '@/lib/security/timing-safe';

export async function POST(request: NextRequest) {
  // Постоянное по времени сравнение: наивное `===` выходит на первом
  // различии, и секрет подбирается по времени ответа посимвольно.
  const isValidCron = timingSafeCompare(
    request.headers.get('x-cron-secret'),
    process.env.CRON_SECRET ?? '',
  );

  if (!isValidCron) {
    const adminOrResponse = await requireAdmin(request);
    if (adminOrResponse instanceof NextResponse) return adminOrResponse;
  }

  let body: { bot?: 'main' | 'admin' | 'kuzmich' } = {};
  try {
    body = await request.json();
  } catch { /* тело необязательно */ }

  const botType = body.bot ?? 'main';
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    return NextResponse.json({ success: false, error: 'TELEGRAM_BOT_TOKEN не задан' }, { status: 500 });
  }

  const set = await setCanonicalWebhook(botToken, { dropPending: true });
  const webhookUrl = set.url;
  if (!set.ok) {
    return NextResponse.json({ success: false, error: set.error, webhookUrl }, { status: 400 });
  }

  // Регистрируем команды
  if (botType === 'kuzmich') {
    await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${botToken}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commands: [
          { command: 'start', description: 'Начать разговор с Кузьмичом' },
          { command: 'help',  description: 'Что умеет этот бот' },
          { command: 'reset', description: 'Очистить историю разговора' },
        ],
      }),
    });
  }

  if (botType === 'main') {
    await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${botToken}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commands: [
          { command: 'start',  description: 'Познакомиться с Кузьмичем' },
          { command: 'route',  description: 'Случайный маршрут из каталога' },
          { command: 'sezon',  description: 'Совет на текущий сезон' },
          { command: 'help',   description: 'Список команд' },
        ],
      }),
    });
  }

  return NextResponse.json({
    success: true,
    webhookUrl,
    bot: botType,
    message: 'Webhook установлен',
  });
}
