/**
 * Meta Business Agent — Unified Webhook
 * Обрабатывает Instagram DM (object: 'instagram') и Facebook Messenger (object: 'page').
 *
 * Настройка:
 *   1. developers.facebook.com → App → Webhooks → Instagram → URL: vedarai.ru/api/meta/webhook
 *   2. То же для Messenger (object: page)
 *   3. Verify Token = META_VERIFY_TOKEN
 *   4. Подписаться на события: messages, messaging_postbacks
 *
 * Env: META_PAGE_ACCESS_TOKEN, META_VERIFY_TOKEN
 *
 * GET  — верификация webhook (hub.challenge handshake)
 * POST — входящие сообщения Instagram DM + Messenger
 */

import { NextRequest, NextResponse } from 'next/server';
import { processMessage, type PendingBooking } from '@/lib/kuzmich/core';

export const dynamic = 'force-dynamic';

// In-memory pending bookings (same pattern as Telegram/WhatsApp handlers)
const pending = new Map<number, PendingBooking>();

// ── Send reply via Meta Graph API ─────────────────────────────────────

async function sendMetaMessage(recipientId: string, text: string): Promise<void> {
  const token = process.env.META_PAGE_ACCESS_TOKEN;
  if (!token) return;

  await fetch('https://graph.facebook.com/v19.0/me/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text: text.slice(0, 2000) },
      access_token: token,
    }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => { /* не блокируем ответ */ });
}

// ── GET: webhook verification ─────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const mode      = searchParams.get('hub.mode');
  const token     = searchParams.get('hub.verify_token');
  const challenge = searchParams.get('hub.challenge');

  const verifyToken = process.env.META_VERIFY_TOKEN;
  if (mode === 'subscribe' && verifyToken && token === verifyToken && challenge) {
    return new Response(challenge, { status: 200 });
  }
  return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
}

// ── Payload types ─────────────────────────────────────────────────────

interface MetaMessage {
  mid?: string;
  text?: string;
  attachments?: Array<{ type: string }>;
}

interface MetaMessagingEntry {
  sender: { id: string };
  recipient: { id: string };
  timestamp: number;
  message?: MetaMessage;
  postback?: { payload: string; title: string };
  read?: unknown;
  delivery?: unknown;
}

interface MetaWebhookBody {
  object: string;
  entry: Array<{
    id: string;
    time?: number;
    messaging?: MetaMessagingEntry[];
  }>;
}

// ── POST: incoming messages ────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as MetaWebhookBody;

    const isInstagram = body.object === 'instagram';
    const isMessenger = body.object === 'page';

    if (!isInstagram && !isMessenger) {
      return NextResponse.json({ ok: true });
    }

    const mode = isInstagram ? 'instagram' : 'messenger';

    for (const entry of body.entry ?? []) {
      for (const event of entry.messaging ?? []) {
        // Пропускаем события доставки и прочтения
        if (!event.message || event.read || event.delivery) continue;

        const senderId = event.sender.id;
        const text = event.message.text;

        // Пропускаем сообщения без текста (вложения, стикеры и т.д.)
        if (!text) continue;

        // Конвертируем Meta string ID → number для совместимости с processMessage
        // Meta IDs обычно ~15 цифр, используем BigInt→Number безопасно через хеш
        const chatId = Number(BigInt(senderId) & BigInt(Number.MAX_SAFE_INTEGER));

        const reply = async (_chatId: number, replyText: string) => {
          await sendMetaMessage(senderId, replyText);
        };

        await processMessage({
          chatId,
          text,
          userName: null,
          mode,
          createdVia: mode,
          pending,
          reply,
        });
      }
    }

    return NextResponse.json({ ok: true });
  } catch {
    // Всегда отвечаем 200 для Meta (иначе отключит webhook)
    return NextResponse.json({ ok: true });
  }
}
