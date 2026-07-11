/**
 * POST /api/mesh/sos-relay
 *
 * Приём SOS, ретранслированного соседним устройством VolcanoMesh.
 * Один сигнал бедствия расходится по мешу всем соседям — каждый онлайн-сосед
 * ретранслирует его сюда. Без дедупликации МЧС-канал получал бы 3-5 копий
 * одного SOS. Дедуп — по sos_id (генерируется устройством-отправителем
 * в момент нажатия SOS), окно 10 минут, in-memory (один Docker-процесс).
 *
 * После дедупа сигнал форвардится в канонический POST /api/safety/sos
 * (не трогаем — CLAUDE.md §7): вся логика записи и алертов остаётся там.
 * ВАЖНО: при сомнении пропускаем сигнал — потерять SOS хуже, чем задублировать.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const RelaySchema = z.object({
  sos_id:        z.string().min(8).max(64),
  relayed_by:    z.string().min(1).max(64),
  origin_device: z.string().max(64).optional(),
  sos: z.object({
    lat:           z.number().min(-90).max(90).nullable().optional(),
    lng:           z.number().min(-180).max(180).nullable().optional(),
    accuracy:      z.number().nullable().optional(),
    message:       z.string().max(500).nullable().optional(),
    tourist_name:  z.string().max(120).nullable().optional(),
    tourist_phone: z.string().max(30).nullable().optional(),
  }),
});

const DEDUP_WINDOW_MS = 10 * 60 * 1000;
const seenSosIds = new Map<string, number>();

// Ретранслятор может честно передавать несколько разных SOS подряд
// (несколько пострадавших в группе), но не бесконечно — защита от абьюза.
const RELAY_LIMIT_PER_IP = 10;
const relayCountByIp = new Map<string, { count: number; windowStart: number }>();

function isDuplicate(sosId: string): boolean {
  const now = Date.now();
  for (const [id, ts] of seenSosIds.entries()) {
    if (now - ts > DEDUP_WINDOW_MS) seenSosIds.delete(id);
  }
  if (seenSosIds.has(sosId)) return true;
  seenSosIds.set(sosId, now);
  return false;
}

function relayLimitExceeded(ip: string): boolean {
  const now = Date.now();
  const entry = relayCountByIp.get(ip);
  if (!entry || now - entry.windowStart > DEDUP_WINDOW_MS) {
    relayCountByIp.set(ip, { count: 1, windowStart: now });
    return false;
  }
  entry.count++;
  return entry.count > RELAY_LIMIT_PER_IP;
}

export async function POST(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '127.0.0.1';

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Невалидный JSON' }, { status: 400 });
  }

  const parsed = RelaySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Некорректные данные ретрансляции' }, { status: 400 });
  }

  if (relayLimitExceeded(ip)) {
    return NextResponse.json(
      { success: false, error: 'Слишком много ретрансляций с этого устройства' },
      { status: 429 },
    );
  }

  const { sos_id, relayed_by, sos } = parsed.data;

  if (isDuplicate(sos_id)) {
    // Сигнал уже дошёл через другого соседа — это успех, не ошибка
    return NextResponse.json({ success: true, deduped: true });
  }

  // Форвард в канонический SOS-роут. x-forwarded-for — IP ретранслятора:
  // rate-limit там остаётся per-устройство, как при прямой отправке,
  // и один сервер-форвард не глушит SOS других пострадавших.
  try {
    const res = await fetch(`${new URL(request.url).origin}/api/safety/sos`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': ip,
        'user-agent': 'VedarMeshRelay/1.0',
      },
      body: JSON.stringify({
        lat:           sos.lat ?? undefined,
        lng:           sos.lng ?? undefined,
        accuracy:      sos.accuracy ?? undefined,
        message:       sos.message ?? undefined,
        tourist_name:  sos.tourist_name ?? undefined,
        tourist_phone: sos.tourist_phone ?? undefined,
        source:        'mesh_relay',
        relayed_by,
      }),
    });

    if (!res.ok && res.status !== 429) {
      // Форвард не прошёл — снимаем дедуп-метку, чтобы другой сосед мог доставить
      seenSosIds.delete(sos_id);
      return NextResponse.json(
        { success: false, error: 'Не удалось передать SOS. Позвоните 112.' },
        { status: 502 },
      );
    }

    return NextResponse.json({ success: true, deduped: false });
  } catch {
    seenSosIds.delete(sos_id);
    return NextResponse.json(
      { success: false, error: 'Не удалось передать SOS. Позвоните 112.' },
      { status: 502 },
    );
  }
}
