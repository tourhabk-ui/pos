/**
 * GET /api/routes/[id]
 * Один маршрут по UUID + предложения операторов из marketplace.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { loadRouteDetail, logQueryFailure } from '@/lib/routes/route-detail';

export const dynamic = 'force-dynamic';

/**
 * Объяснение вердикта спрашивается ЯВНО и стоит денег: за ним идёт вызов
 * модели. На каждое открытие карточки его не просят — только когда человек
 * нажал «Что это значит».
 */
const ExplainQuery = z.object({ explain: z.enum(['0', '1']).optional() });

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const queryParsed = ExplainQuery.safeParse({
    explain: new URL(_req.url).searchParams.get('explain') ?? undefined,
  });
  if (!queryParsed.success) {
    return NextResponse.json({ success: false, error: 'Некорректный параметр explain' }, { status: 400 });
  }
  const wantExplain = queryParsed.data.explain === '1';

  if (!id || !/^[0-9a-f-]{36}$/.test(id)) {
    return NextResponse.json({ success: false, error: 'Некорректный ID' }, { status: 400 });
  }

  try {
    // Сборка карточки — lib/routes/route-detail (её же зовёт серверный рендер
    // страницы). Просмотр засчитывается здесь: этот запрос шлёт браузер.
    const detail = await loadRouteDetail(id, { explain: wantExplain, countView: true });
    if (detail.kind === 'not_found') {
      return NextResponse.json({ success: false, error: 'Маршрут не найден' }, { status: 404 });
    }
    return NextResponse.json({ success: true, data: detail.data });
  } catch (error) {
    // Раньше причина уходила только в ответ и только в dev — то есть в
    // проде не сохранялась нигде. Теперь она в логе всегда, с SQLSTATE и
    // формой запроса; наружу по-прежнему нейтральный текст.
    logQueryFailure('route_detail', error, id);
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { success: false, error: 'Ошибка загрузки маршрута', details: process.env.NODE_ENV === 'development' ? msg : undefined },
      { status: 500 }
    );
  }
}
