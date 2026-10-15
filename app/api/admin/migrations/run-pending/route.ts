/**
 * POST /api/admin/migrations/run-pending — снят 15.10 (аудит, находка P4-04).
 *
 * CLAUDE.md: «НИКОГДА не применять миграции через HTTP endpoint». Этот роут
 * делал ровно это — и хуже, чем законный раннер, по трём пунктам сразу:
 *   • применённое НЕ записывалось в `_migrations` (единственное обращение к
 *     журналу было SELECT), значит следующий деплой накатывал те же файлы
 *     второй раз — для миграции данных (INSERT без ON CONFLICT, UPDATE с
 *     арифметикой) это двойная запись;
 *   • порядок файлов — голый `.sort()`, посимвольный: `1000_` раньше `999_`;
 *   • конфликт на UPDATE записывался как «Already exists» — «не смог» за
 *     «сделано» (урок миграции 988 сюда не дошёл).
 *
 * Применяет миграции только деплой: `start.js` → `scripts/migrate-standalone.js`.
 * Упавшая миграция повторяется на следующем выкате; что не применено и почему —
 * `GET /api/admin/migrations/status`.
 *
 * 410, а не удаление файла: 404 неотличим от опечатки в пути, а старая вкладка
 * админки должна получить объяснение.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { MIGRATIONS_DEPLOY_ONLY } from '@/lib/agents/migration-status';

export const dynamic = 'force-dynamic';

// AUTH: requireAdmin — первой строкой, как у живого роута. Заглушка базы не
// трогает, но дверь админки не становится анонимной оттого, что за ней пусто:
// ответ 410 рассказывает, как устроен накат, и предназначен админу, а Edge
// пропускает на /api/admin/* ещё и CRON_SECRET. Без проверки роут выпадает и
// из-под сторожа периметра `api-guard-before-action` (аудит 15.10, P4-04).
export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  return NextResponse.json(
    { success: false, error: MIGRATIONS_DEPLOY_ONLY, status_url: '/api/admin/migrations/status' },
    { status: 410 },
  );
}
