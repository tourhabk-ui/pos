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
 *
 * Принципы (жизнекритично, потерять SOS хуже, чем задублировать):
 * - дедуп ДО лимитера: повторные копии одного sos_id не жгут бюджет узла;
 * - rate-limit снимает дедуп-метку: не форварднули — не помечаем доставленным;
 * - x-forwarded-for форварда — синтетический IP ПОСТРАДАВШЕГО (из UUID его
 *   устройства), а не ретранслятора: rate-limit канонического роута
 *   (1 SOS / 10 мин / IP) остаётся per-жертва, и один занятой узел-ретранслятор
 *   не глушит SOS второго пострадавшего;
 * - форвард ретраится до 3 раз до признания неудачи.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';
import { syntheticVictimIp } from '@/lib/mesh/victim-ip';

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

// Защита от абьюза: 30 РАЗНЫХ сигналов / 10 мин с одного IP.
// Дубли (тот же sos_id) сюда не доходят — дедуп срабатывает раньше,
// поэтому большая группа за одним NAT не выжигает бюджет копиями.
const relayLimiter = createRateLimiter({ windowMs: DEDUP_WINDOW_MS, max: 30 });

function isDuplicate(sosId: string): boolean {
  const now = Date.now();
  for (const [id, ts] of seenSosIds.entries()) {
    if (now - ts > DEDUP_WINDOW_MS) seenSosIds.delete(id);
  }
  if (seenSosIds.has(sosId)) return true;
  seenSosIds.set(sosId, now);
  return false;
}

export async function POST(request: NextRequest) {
  const relayerIp = getClientIp(request.headers);

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

  const { sos_id, relayed_by, origin_device, sos } = parsed.data;

  // 1. Дедуп — раньше лимитера: копии одного сигнала бесплатны
  if (isDuplicate(sos_id)) {
    // Сигнал уже дошёл через другого соседа — это успех, не ошибка
    return NextResponse.json({ success: true, deduped: true });
  }

  // 2. Лимитер — только для реально новых сигналов
  if (!relayLimiter.check(relayerIp)) {
    // Не форвардим → снимаем метку, чтобы другой ретранслятор мог доставить
    seenSosIds.delete(sos_id);
    return NextResponse.json(
      { success: false, error: 'Слишком много ретрансляций с этого устройства' },
      { status: 429 },
    );
  }

  // 3. Форвард в канонический SOS-роут от имени ПОСТРАДАВШЕГО (синтетический
  //    IP из его device id): rate-limit канона остаётся per-жертва.
  const victimKey = syntheticVictimIp(origin_device || relayed_by);
  const forwardBody = JSON.stringify({
    lat:           sos.lat ?? undefined,
    lng:           sos.lng ?? undefined,
    accuracy:      sos.accuracy ?? undefined,
    message:       sos.message ?? undefined,
    tourist_name:  sos.tourist_name ?? undefined,
    tourist_phone: sos.tourist_phone ?? undefined,
    source:        'mesh_relay',
    relayed_by,
  });

  const res = await (async () => {
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch(`${new URL(request.url).origin}/api/safety/sos`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-forwarded-for': victimKey,
            'user-agent': 'VedarMeshRelay/1.0',
          },
          body: forwardBody,
        });
        // 429 канона теперь означает «эта жертва уже доставлена <10 мин назад»
        // (ключ per-жертва) — это успех дедупа, не сбой.
        if (r.ok || r.status === 429) return r;
      } catch {
        // сетевой сбой — ретраим
      }
      if (i < 2) await new Promise((resolve) => setTimeout(resolve, 300 * (i + 1)));
    }
    return null;
  })();

  if (!res) {
    // Форвард не прошёл после ретраев — снимаем дедуп-метку,
    // чтобы копия от другого соседа могла доставить сигнал
    seenSosIds.delete(sos_id);
    return NextResponse.json(
      { success: false, error: 'Не удалось передать SOS. Позвоните 112.' },
      { status: 502 },
    );
  }

  return NextResponse.json({ success: true, deduped: false });
}
