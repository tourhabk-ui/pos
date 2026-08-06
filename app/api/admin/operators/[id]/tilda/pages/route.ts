/**
 * GET /api/admin/operators/[id]/tilda/pages — что видно через Tilda API партнёра.
 *
 * Живая проверка ключей и данные для SEO-аудита: список проектов и НАСТОЯЩИЙ
 * список страниц (у fishingkam.ru sitemap из одного URL — реальный состав
 * страниц видно только через API). Читаем с прода: RF-хостинг Tilda пускает,
 * зарубежные IP и песочницы — нет.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import {
  getTildaCredentials,
  tildaCall,
  type TildaProject,
  type TildaPage,
} from '@/lib/integrations/tilda';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const creds = await getTildaCredentials(id);
  if (!creds) {
    return NextResponse.json(
      { error: 'Ключи Tilda не настроены — добавьте их в карточке партнёра' },
      { status: 404 },
    );
  }

  try {
    const projects = await tildaCall<TildaProject[]>('getprojectslist', {}, creds);

    // Страницы первых трёх проектов (обычно проект один; бережём лимит 150/час).
    const pagesByProject: Array<{ project: TildaProject; pages: TildaPage[] }> = [];
    for (const project of projects.slice(0, 3)) {
      const pages = await tildaCall<TildaPage[]>('getpageslist', { projectid: project.id }, creds);
      pagesByProject.push({
        project,
        pages: pages.map((p) => ({
          id: p.id,
          projectid: p.projectid,
          title: p.title,
          descr: p.descr,
          alias: p.alias,
          published: p.published,
          filename: p.filename,
        })),
      });
    }

    return NextResponse.json({
      success: true,
      projects_total: projects.length,
      projects: pagesByProject.map(({ project, pages }) => ({
        id: project.id,
        title: project.title,
        pages_total: pages.length,
        pages,
      })),
    });
  } catch (e) {
    // Причина отказа Tilda — админу как есть: «неверный ключ» и «лимит
    // запросов» требуют разных действий.
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Tilda API недоступен' },
      { status: 502 },
    );
  }
}
