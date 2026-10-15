/**
 * POST /api/admin/migrations/apply — снят 15.10 (аудит, находка P4-04).
 *
 * CLAUDE.md: «НИКОГДА не применять миграции через HTTP endpoint». Этот роут
 * выполнял файл миграции одним `pool.query(sql)` по номеру из тела запроса:
 * без транзакции, без записи в `_migrations` и без `_migration_failures`.
 * Применённое отсюда следующий деплой накатывал второй раз, а упавшее не
 * оставляло следа нигде, кроме ответа браузеру.
 *
 * Применяет миграции только деплой: `start.js` → `scripts/migrate-standalone.js`.
 * Упавшая миграция повторяется на следующем выкате; что не применено и почему —
 * `GET /api/admin/migrations/status`.
 *
 * 410, а не удаление файла: 404 неотличим от опечатки в пути.
 */

import { NextResponse } from 'next/server';
import { MIGRATIONS_DEPLOY_ONLY } from '@/lib/agents/migration-status';

export const dynamic = 'force-dynamic';

// AUTH: заглушка ничего не читает и не пишет — проверять права не у чего;
// Edge (middleware.ts) по-прежнему пускает к /api/admin/* только админа.
export async function POST() {
  return NextResponse.json(
    { success: false, error: MIGRATIONS_DEPLOY_ONLY, status_url: '/api/admin/migrations/status' },
    { status: 410 },
  );
}
