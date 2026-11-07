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
 * Env: META_PAGE_ACCESS_TOKEN, META_VERIFY_TOKEN, META_APP_SECRET
 *
 * GET  — верификация webhook (hub.challenge handshake)
 * POST — входящие сообщения Instagram DM + Messenger; подпись Meta
 *        (X-Hub-Signature-256) сверяется до разбора тела —
 *        lib/meta/webhook-signature.ts. Адрес на проде закрыт Edge: его нет в
 *        реестре публичных API (lib/auth/public-api-routes.ts).
 */

import { NextRequest, NextResponse } from 'next/server';
import { processMessage, type PendingBooking } from '@/lib/kuzmich/core';
import {
  META_APP_SECRET_ENV, META_SIGNATURE_HEADER, metaHandshakeOk, verifyMetaSignature,
} from '@/lib/meta/webhook-signature';
import { refuseUnconfiguredWebhook } from '@/lib/telegram/webhook-secret';

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

  if (metaHandshakeOk(mode, token, challenge, process.env.META_VERIFY_TOKEN)) {
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
  // Подпись — до разбора тела: подделке тело не разбирается и Кузьмич не зовётся.
  let raw: Buffer;
  try {
    raw = Buffer.from(await req.arrayBuffer());
  } catch (err) {
    console.error('[meta/webhook] тело не прочиталось:', err instanceof Error ? err.message : String(err));
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const verdict = verifyMetaSignature(raw, req.headers.get(META_SIGNATURE_HEADER), process.env[META_APP_SECRET_ENV]);
  if (verdict === 'not_configured') return refuseUnconfiguredWebhook('meta/webhook', META_APP_SECRET_ENV);
  if (verdict === 'forbidden') {
    console.error('[meta/webhook] подпись X-Hub-Signature-256 не сошлась — запрос не обработан');
    return NextResponse.json({ ok: false }, { status: 403 });
  }

  try {
    const body = JSON.parse(raw.toString('utf8')) as MetaWebhookBody;

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
  } catch (err) {
    // Подписанному запросу — 200 и при сбое: на череду ошибок Meta отключает
    // вебхук. Сбой не глушится — он в логе (§4.0).
    console.error('[meta/webhook] сбой обработки:', err instanceof Error ? err.message : String(err));
    return NextResponse.json({ ok: true });
  }
}
