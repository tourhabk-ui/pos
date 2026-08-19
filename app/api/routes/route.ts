/**
 * GET /api/routes
 * Публичный каталог маршрутов из agent_route_knowledge.
 * Поддерживает: поиск, фильтрацию по категории, пагинацию, geo-фильтр.
 *
 * Query-логика вынесена в lib/routes/catalog-query.ts — общий data-слой с
 * SSR-рендером app/routes/page.tsx (шаг 3 аудита 11.07), чтобы листинг и API
 * не разъехались. Здесь остаётся только HTTP-обёртка.
 */

import { NextRequest, NextResponse } from 'next/server';
import { CatalogQuerySchema, queryCatalog } from '@/lib/routes/catalog-query';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const parsed = CatalogQuerySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams)
  );
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Неверные параметры запроса' }, { status: 400 });
  }

  try {
    const { items, meta } = await queryCatalog(parsed.data);
    const response = NextResponse.json({ success: true, data: items, meta });
    response.headers.set('Cache-Control', 'private, no-cache');
    return response;
  } catch (error) {
    /**
     * Наружу — нейтральный текст, в лог — доказательство.
     *
     * Прежнее «Ошибка базы данных. Проверьте DATABASE_URL в env.» уходило
     * туристу в браузер и было неправдой: подключение живо, падал конкретный
     * запрос. Этот совет всю ночь 15–16.08 уводил в сторону — искали
     * переменную окружения, а причиной была неоднозначная колонка. Публичный
     * текст не должен ставить диагноз, тем более чужой.
     *
     * В лог — то, чем чинят: SQLSTATE (род поломки называется однозначно, в
     * отличие от текста), форма запроса (какая ветка каталога) и релиз.
     * Без формы запроса ошибка не воспроизводится: 16.08 диагностика
     * проверяла `kind=place`, а падал `kind=route&has_waypoints=true`.
     */
    const e = error as Error & { code?: string; detail?: string; position?: string };
    console.error('[/api/routes] запрос каталога упал', {
      sqlstate: e?.code,
      message: e?.message,
      detail: e?.detail,
      position: e?.position,
      request: parsed.data,
      release: process.env.RELEASE_SHA ?? null,
    });
    return NextResponse.json(
      { success: false, error: 'Не удалось загрузить каталог. Повторите позже.' },
      { status: 503 }
    );
  }
}
