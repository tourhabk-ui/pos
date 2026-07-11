/**
 * POST /api/admin/registry/reconcile — сверить операторов (partners) с уже
 * загруженным снимком официального реестра official_registry_operators и
 * проставить partners.registry_status (issue #368).
 *
 * Снимок реестра наполняется скриптом scrape-registry-visitkamchatka.js —
 * этот эндпоинт сеть НЕ трогает, работает только по данным БД.
 *
 * Auth: requireAdmin. Тело: { dryRun?: boolean }.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { reconcileRegistry } from '@/lib/services/operator-registry.service';
import { z } from 'zod';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const bodySchema = z.object({
  dryRun: z.boolean().optional().default(false),
});

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  let raw: unknown = {};
  try {
    const text = await request.text();
    raw = text ? JSON.parse(text) : {};
  } catch {
    return NextResponse.json({ success: false, error: 'Некорректный JSON в теле запроса' }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные параметры' },
      { status: 400 },
    );
  }

  try {
    const summary = await reconcileRegistry(parsed.data.dryRun);
    return NextResponse.json({ success: true, summary });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { success: false, error: 'Ошибка сверки с реестром', detail: msg },
      { status: 500 },
    );
  }
}
