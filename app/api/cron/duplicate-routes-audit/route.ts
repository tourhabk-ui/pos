/**
 * GET /api/cron/duplicate-routes-audit?secret=<CRON_SECRET>
 *
 * Сколько маршрутов в справочнике описывают одно и то же.
 *
 * Зачем: пересуд привязок 11.08 дал 106 «неоднозначных» треков — рядом с
 * каждым стоял другой маршрут вплотную. Разбор показал, что это в основном
 * не чужие привязки, а наши собственные двойники: «Вулкан Горелый» дважды,
 * «Пиначево - Центральный» и «Пиначево — Центральный» через разное тире.
 *
 * Значит часть «лажи с маршрутами» не про геометрию: объектов в справочнике
 * больше, чем мест на Камчатке.
 *
 * READ-ONLY, под CRON_SECRET: ничего не пишет и ничего не сливает. Слияние
 * записей — решение человека, и принимать его по одной близости якорей
 * нельзя (урок Эссо: общая перевалка — не общий объект).
 */

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { runDuplicateAudit } from '@/lib/routes/duplicate-audit';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const audit = await runDuplicateAudit();
    return NextResponse.json({ success: true, ...audit });
  } catch (err) {
    // Пустой ответ читался бы как «дубликатов нет».
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Перепись не выполнена' },
      { status: 500 },
    );
  }
}
