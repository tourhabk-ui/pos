/**
 * GET /api/cron/schema-drift — что миграции обещали и чего на базе нет.
 * ТОЛЬКО ЧТЕНИЕ.
 *
 * Отличие от /api/cron/schema-audit: тот считает «не применилось» по именам
 * файлов (файл образа отсутствует в `_migrations`) и по построению слеп к
 * файлу, который записан применённым, но откатился. Здесь сравниваются
 * ДЕЙСТВИЯ: объявленные колонки против information_schema живой базы.
 *
 * Спрашивает прод сам себя — с раннера GitHub в managed PostgreSQL Timeweb
 * не пройти (проверено четырьмя прогонами), а прод ходит в свою базу
 * свободно. Тот же приём, что у schema-audit.
 *
 * Наружу уходят только имена: таблиц, колонок, файлов миграций. Ответ
 * читают в логах Actions — значений из пользовательских данных в нём нет.
 */

import { NextRequest, NextResponse } from 'next/server';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import { parseDeclarations, diffAgainstActual, type DriftReport } from '@/lib/db/schema-drift';

export const dynamic = 'force-dynamic';

/**
 * Объявлено миграцией, отсутствует на проде СОЗНАТЕЛЬНО.
 *
 * Список пуст намеренно: заполнять его можно только по итогам первого
 * прогона на боевой базе, поимённо и с причиной. Догадка о том, что «эта
 * таблица, наверное, не нужна», — это выключение сигнализации, а не
 * настройка. Каждая запись обязана называть, КТО и КОГДА решил, что
 * объекта быть не должно.
 */
const INTENTIONALLY_ABSENT: ReadonlySet<string> = new Set<string>([]);

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const empty: DriftReport = {
    ok: false,
    declared_tables: 0,
    actual_relations: 0,
    missing_tables: [],
    missing_columns: [],
  };

  let files: Array<{ name: string; sql: string }>;
  try {
    const dir = join(process.cwd(), 'migrations');
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf-8') }));
  } catch (err) {
    // Каталога нет в образе — сказать «расхождений нет» здесь было бы враньём.
    return NextResponse.json(
      { ...empty, reason: `каталог migrations/ не прочитан: ${err instanceof Error ? err.message : 'причина неизвестна'}` },
      { status: 500 },
    );
  }

  if (files.length === 0) {
    return NextResponse.json({ ...empty, reason: 'в образе нет ни одного файла миграции' }, { status: 500 });
  }

  try {
    // Представления тоже считаются существующими: таблица, ставшая
    // представлением (agent_route_knowledge, миграция 663), не пропала.
    const { rows } = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'`,
    );

    const actual = new Map<string, Set<string>>();
    for (const r of rows) {
      if (!actual.has(r.table_name)) actual.set(r.table_name, new Set());
      actual.get(r.table_name)!.add(r.column_name);
    }

    const declared = parseDeclarations(files);
    const diff = diffAgainstActual(declared, actual, INTENTIONALLY_ABSENT);

    return NextResponse.json({
      ok: true,
      collected_at: new Date().toISOString(),
      migration_files: files.length,
      ...diff,
      drift_total: diff.missing_tables.length + diff.missing_columns.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'база не ответила';
    console.error('[schema-drift] сверка не выполнена:', message);
    return NextResponse.json({ ...empty, reason: message }, { status: 500 });
  }
}
