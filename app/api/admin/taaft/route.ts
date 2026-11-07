/**
 * GET /api/admin/taaft — сторонние сервисы для админки (external_tools).
 *
 * Здесь всё, что лежит в таблице, включая не показываемое (verified = FALSE),
 * со щелчками людей (click_count) — единственным счётчиком, который значит то,
 * что говорит. Счётчик попаданий в ответ Кузьмича (use_count) и рейтинг сюда
 * не отдаются: страница выдавала первое за «использования», второго не было.
 *
 * Добавления через API больше нет (07.11): записи без источника и проверки
 * — ровно то, что пришлось чистить миграцией 1396. Новое приложение
 * кладётся миграцией с источником, как 1396.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

export interface AdminExternalTool {
  slug: string;
  name: string;
  description: string;
  url: string;
  category: string;
  is_free: boolean;
  verified: boolean;
  click_count: number;
  updated_at: string;
}

export async function GET(request: NextRequest) {
  const authError = await requireAdmin(request);
  if (authError instanceof NextResponse) return authError;

  try {
    const { rows } = await pool.query<AdminExternalTool>(
      `SELECT slug, name, description, url, category, is_free, verified, click_count, updated_at
         FROM external_tools
        ORDER BY verified DESC, category, name`,
    );
    return NextResponse.json({ tools: rows });
  } catch (error) {
    console.error(
      '[admin/taaft] список не прочитан:',
      (error as { code?: string })?.code ?? '',
      error instanceof Error ? error.message : error,
    );
    return NextResponse.json({ error: 'Список сторонних сервисов не загрузился' }, { status: 500 });
  }
}
