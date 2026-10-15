/**
 * GET  /api/telegram/register-kuzmich?secret=CRON_SECRET
 * POST /api/telegram/register-kuzmich
 *
 * Ставит вебхук бота (главный адрес с секретом — setCanonicalWebhook, аудит
 * 15.10) и команды меню. Прежде ставил /api/telegram/kuzmich без секрета.
 * Токен — TELEGRAM_BOT_TOKEN: им отвечают оба обработчика, и вебхук другого
 * бота на нашем адресе получал бы ответы не тем ботом.
 */
import { NextRequest, NextResponse } from 'next/server';
import { verifyCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { setCanonicalWebhook } from '@/lib/telegram/operator-availability';
export const dynamic = 'force-dynamic';

async function registerWebhook(token: string) {
  const set = await setCanonicalWebhook(token, { dropPending: true });
  const webhookUrl = set.url;
  const data = { ok: set.ok, description: set.ok ? undefined : set.error };

  if (data.ok) {
    await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: [
        { command: 'start',   description: 'Начать' },
        { command: 'help',    description: 'Что умеет бот' },
        { command: 'reset',   description: 'Сбросить историю' },
        { command: 'kuzmich', description: 'Опубликовать пост о маршруте' },
        { command: 'tip',     description: 'Опубликовать совет Кузьмича' },
        { command: 'sezon',   description: 'Опубликовать сезонный пост' },
      ]}),
    });
  }

  return { ok: data.ok, webhookUrl, description: data.description };
}

export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return NextResponse.json({ error: 'TELEGRAM_BOT_TOKEN не задан на Timeweb' }, { status: 500 });
  }

  const result = await registerWebhook(token);
  return NextResponse.json(result);
}

export async function POST(request: NextRequest) {
  // Заголовок свой (x-cron-secret), поэтому verifyCronSecret не подходит —
  // но сравнение обязано быть постоянным по времени и здесь.
  if (!timingSafeCompare(request.headers.get('x-cron-secret'), process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return NextResponse.json({ error: 'TELEGRAM_BOT_TOKEN не задан', hint: 'Задай на Timeweb' }, { status: 500 });
  }

  const result = await registerWebhook(token);
  return NextResponse.json(result);
}
