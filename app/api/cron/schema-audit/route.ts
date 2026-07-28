/**
 * GET /api/cron/schema-audit — факты о боевой схеме. ТОЛЬКО ЧТЕНИЕ.
 *
 * Спросить базу напрямую с раннера GitHub нельзя: managed PostgreSQL Timeweb не
 * пускает внешние адреса. Проверено четырьмя прогонами (10.07 — три, 28.07 —
 * один) двумя разными способами разбора строки подключения: везде TCP-таймаут.
 * Зато прод ходит в свою базу свободно, а раннер свободно ходит в прод по
 * HTTPS — на этом стоят все кроны платформы. Поэтому спрашивает прод.
 *
 * Отвечает на вопросы, которые до сих пор решались рассуждением по исходникам:
 * какие колонки есть на самом деле, `bookings` — таблица или представление,
 * какие миграции не применились (список считается ЗДЕСЬ, по файлам образа, а не
 * по файлам репозитория — поэтому это именно «не применилось»), создался ли
 * уникальный индекс по telegram_id и есть ли дубли.
 *
 * Наружу уходят только метаданные и счётчики: имена таблиц, колонок, типов,
 * индексов, имена миграций, количества строк. Ни одного значения из
 * пользовательских данных — ответ попадает в лог GitHub Actions.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { collectSchemaFacts } from '@/lib/db/schema-facts';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const facts = await collectSchemaFacts();
    return NextResponse.json({ success: true, collected_at: new Date().toISOString(), ...facts });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка чтения схемы';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
