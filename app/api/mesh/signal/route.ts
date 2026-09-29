import { NextRequest } from 'next/server';
import {
  registerDevice,
  removeDevice,
  sendToDevice,
  getRoomPeers,
  roomOfDevice,
} from '@/lib/mesh/signaling-store';
import { roomsAreNeighbors } from '@/lib/mesh/rooms';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';

export const runtime = 'nodejs'; // SSE requires Node.js runtime

/**
 * Проверка безопасности 29.09 (#2073). Роут публичный by design (меш для
 * анонимов, public-api-routes), но до этого дня не проверял ничего:
 * произвольный deviceId и комната, пересылка сообщения любого размера на
 * любой deviceId с любого конца края, без потолка частоты. Теперь:
 *   - deviceId и комната — ограниченной формы;
 *   - занятый чужой deviceId не перехватывается (см. registerDevice);
 *   - сообщение идёт только между СОСЕДНИМИ комнатами: отправитель обязан
 *     быть на связи рядом с получателем;
 *   - размер и частота ограничены на адрес.
 * Клиент меша (lib/mesh/volcano-mesh) всему этому уже соответствует.
 */
const DEVICE_RE = /^[A-Za-z0-9_-]{1,128}$/;
const ROOM_RE = /^vol--?\d{1,4}--?\d{1,5}$/;
const MAX_MESSAGE_BYTES = 64 * 1024;
const connectLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });
// ICE-кандидаты идут пачками по нескольку десятков на соседа — потолок щедрый.
const relayLimiter = createRateLimiter({ windowMs: 60_000, max: 600 });

export async function GET(req: NextRequest): Promise<Response> {
  const deviceId = req.nextUrl.searchParams.get('deviceId');
  const room = req.nextUrl.searchParams.get('room');

  if (!deviceId || !room) {
    return new Response('Missing deviceId or room', { status: 400 });
  }
  if (!DEVICE_RE.test(deviceId) || !ROOM_RE.test(room)) {
    return new Response('Invalid deviceId or room', { status: 400 });
  }
  const ip = getClientIp(req.headers);
  if (!connectLimiter.check(`mesh-connect:${ip}`)) {
    return new Response('Too many connections', { status: 429 });
  }

  const encoder = new TextEncoder();
  let keepalive: ReturnType<typeof setInterval>;
  let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
  let taken = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      ctrl = controller;
      if (!registerDevice(deviceId, room, controller, ip)) {
        taken = true;
        controller.close();
        return;
      }

      const peers = getRoomPeers(room, deviceId);
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ type: 'room-peers', peers })}\n\n`),
      );

      keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        } catch {
          clearInterval(keepalive);
        }
      }, 25000);
    },
    cancel() {
      clearInterval(keepalive);
      if (ctrl) removeDevice(deviceId, ctrl);
    },
  });

  if (taken) return new Response('Device id is in use', { status: 409 });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  const ip = getClientIp(req.headers);
  if (!relayLimiter.check(`mesh-relay:${ip}`)) {
    return new Response('Too many messages', { status: 429 });
  }

  const raw = await req.text().catch(() => '');
  if (raw.length > MAX_MESSAGE_BYTES) return new Response('Message too large', { status: 413 });

  let body: { to?: unknown; message?: unknown };
  try {
    body = JSON.parse(raw) as { to?: unknown; message?: unknown };
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const { to, message } = body;
  if (typeof to !== 'string' || !DEVICE_RE.test(to) || !message || typeof message !== 'object') {
    return new Response('Missing to/message', { status: 400 });
  }

  // Отправитель — тот, кто назван в сообщении; он обязан быть на связи в
  // соседней с получателем комнате. Это не делает подделку невозможной, но
  // закрывает рассылку на любой deviceId края из любого места.
  const from = (message as { from?: unknown }).from;
  const fromRoom = typeof from === 'string' && DEVICE_RE.test(from) ? roomOfDevice(from) : null;
  const toRoom = roomOfDevice(to);
  if (!fromRoom || !toRoom || !roomsAreNeighbors(fromRoom, toRoom)) {
    return Response.json({ delivered: false });
  }

  const delivered = sendToDevice(to, message);
  return Response.json({ delivered });
}
