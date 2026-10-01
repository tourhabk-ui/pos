/**
 * GET /api/parks/[slug]
 * Публичный. Данные парка (справочник parks, migration 712) + маршруты внутри.
 * Загрузчик общий со страницей /park/[slug] — lib/parks/park-page.ts.
 *
 * `mchs_phone` НЕ отдаётся намеренно (15.09): региональный номер берётся из
 * единого проверенного источника, а не из колонки парка — второй источник
 * того же факта это два разных факта, и в ЧП цена расхождения — чужой гудок.
 */
import { NextResponse } from 'next/server';
import { loadParkPage } from '@/lib/parks/park-page';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  try {
    const park = await loadParkPage(slug);
    if (!park) {
      return NextResponse.json({ error: 'Парк не найден' }, { status: 404 });
    }
    return NextResponse.json(park);
  } catch (e) {
    const err = e as { code?: string; message?: string };
    console.error('[api/parks] парк не прочитан:', slug, `sqlstate=${err?.code ?? 'нет'}`, err?.message ?? String(e));
    return NextResponse.json({ error: 'Ошибка загрузки парка' }, { status: 500 });
  }
}
