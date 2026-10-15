/**
 * GET /api/admin/migrations/status — что не применено и почему (только чтение).
 *
 * Заведён 15.10 вместо ручного наката (аудит, находка P4-04): кнопка
 * «Применить миграции» в админке катила файлы через HTTP, не отмечая их в
 * `_migrations`, и следующий деплой накатывал их второй раз. Применяет теперь
 * только деплой (`start.js` → `scripts/migrate-standalone.js`), а экран
 * `/hub/admin/migrations` показывает состояние: каталог `migrations/` образа
 * против журнала `_migrations` и записанных причин из `_migration_failures`.
 *
 * Ни INSERT, ни UPDATE, ни DDL здесь нет ни при каком запросе.
 *
 * Третий исход (§4.0): каталог не прочитан или журнал не ответил — это 500
 * «не смог проверить», а не «всё применено». Не прочиталась только таблица
 * причин — ответ есть, но `reasons_known: false`: причины неизвестны, а не
 * отсутствуют.
 */

import { NextRequest, NextResponse } from 'next/server';
import { readdirSync } from 'fs';
import { join } from 'path';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { buildMigrationStatus, type MigrationFailure } from '@/lib/agents/migration-status';

export const dynamic = 'force-dynamic';

function describeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const code = typeof e === 'object' && e !== null && 'code' in e
    ? String((e as { code: unknown }).code)
    : '';
  return code ? `${code}: ${msg}` : msg;
}

interface FailureRow {
  name: string;
  error: string | null;
  attempts: number | null;
  last_failed_at: Date | string | null;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  // 1. Каталог образа. Пустой — так же «не с чем сверить», как и нечитаемый:
  //    ноль файлов на входе не превращается в «неприменённых нет».
  let files: string[];
  try {
    files = readdirSync(join(process.cwd(), 'migrations')).filter((f) => f.endsWith('.sql'));
  } catch (e) {
    const reason = describeError(e);
    console.error('[admin/migrations/status] каталог migrations/ не прочитан:', reason);
    return NextResponse.json(
      { success: false, error: `Каталог migrations/ в образе не прочитан — сверять не с чем (${reason})` },
      { status: 500 },
    );
  }
  if (files.length === 0) {
    console.error('[admin/migrations/status] каталог migrations/ пуст');
    return NextResponse.json(
      { success: false, error: 'Каталог migrations/ в образе пуст — сверять не с чем' },
      { status: 500 },
    );
  }

  // 2. Журнал применённого. Без него ответа нет вовсе.
  let applied: string[];
  try {
    const { rows } = await pool.query<{ name: string }>('SELECT name FROM _migrations');
    applied = rows.map((r) => r.name);
  } catch (e) {
    const reason = describeError(e);
    console.error('[admin/migrations/status] журнал _migrations не прочитан:', reason);
    return NextResponse.json(
      { success: false, error: `Журнал _migrations не прочитан: ${reason}` },
      { status: 500 },
    );
  }

  // 3. Причины падений. Не прочитались — состояние всё равно отдаётся, но с
  //    пометкой, что причины неизвестны.
  let failures: MigrationFailure[] | null = null;
  let failuresError: string | null = null;
  try {
    const { rows } = await pool.query<FailureRow>(
      `SELECT name, error, attempts, last_failed_at FROM _migration_failures`,
    );
    failures = rows.map((r) => ({
      name: r.name,
      error: r.error ?? '',
      attempts: Number(r.attempts ?? 0),
      last_failed_at: r.last_failed_at instanceof Date
        ? r.last_failed_at.toISOString()
        : r.last_failed_at,
    }));
  } catch (e) {
    failuresError = describeError(e);
    console.error('[admin/migrations/status] причины _migration_failures не прочитаны:', failuresError);
  }

  return NextResponse.json({
    success: true,
    ...buildMigrationStatus(files, applied, failures),
    failures_error: failuresError,
  });
}
