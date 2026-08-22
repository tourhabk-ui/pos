/**
 * POST /api/pwa/install
 *
 * Анонимный учёт установок PWA. Клиент шлёт свой client_id (случайный UUID из
 * localStorage — не ПД) при событии appinstalled и при запуске установленного
 * приложения (standalone). Дедуп по client_id: одно устройство = одна строка.
 *
 * Без авторизации (анонимный сигнал с любого устройства). Без ПД — телефон/
 * почта/имя сюда не попадают, PII-гарды (§8) не затрагиваются.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  // UUID из crypto.randomUUID(); допускаем любой разумный непустой идентификатор,
  // но режем длину, чтобы не приняли мусор произвольного размера.
  clientId: z.string().min(8).max(64),
  platform: z.enum(['android', 'ios', 'desktop', 'unknown']).optional(),
  source: z.enum(['appinstalled', 'standalone-launch']).optional(),
});

const limiter = createRateLimiter({ windowMs: 60_000, max: 10 });

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!limiter.check(getClientIp(request.headers))) {
    return NextResponse.json({ error: 'Слишком часто' }, { status: 429 });
  }
  let parsed: z.infer<typeof BodySchema>;
  try {
    parsed = BodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Некорректные данные' }, { status: 400 });
  }

  const { clientId, platform, source } = parsed;

  try {
    await pool.query(
      `INSERT INTO pwa_installs (client_id, platform, install_source, first_seen, last_seen)
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT (client_id) DO UPDATE
         SET last_seen = NOW(),
             -- платформу проставляем, если раньше её не знали
             platform = COALESCE(pwa_installs.platform, EXCLUDED.platform),
             -- appinstalled — более сильный сигнал, чем standalone-launch:
             -- если пришло явное событие установки, фиксируем именно его
             install_source = CASE
               WHEN EXCLUDED.install_source = 'appinstalled' THEN 'appinstalled'
               ELSE COALESCE(pwa_installs.install_source, EXCLUDED.install_source)
             END`,
      [clientId, platform ?? null, source ?? null],
    );
    return NextResponse.json({ ok: true });
  } catch {
    // Тихо: аналитика установок не должна ломать клиент.
    return NextResponse.json({ ok: false }, { status: 200 });
  }
}
