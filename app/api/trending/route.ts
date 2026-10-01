import { NextResponse } from 'next/server';
import { loadTrending, type TrendingKind } from '@/lib/trending/load';

export const dynamic = 'force-dynamic';

/**
 * Популярные места и маршруты. Загрузчик общий со страницей /trending —
 * lib/trending/load.ts (там же разбор фильтров и id-пространства).
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const raw = searchParams.get('type') ?? 'all';
  const kind: TrendingKind = raw === 'places' || raw === 'routes' ? raw : 'all';
  const parsed = parseInt(searchParams.get('limit') ?? '12', 10);
  const limit = Math.min(Number.isFinite(parsed) && parsed > 0 ? parsed : 12, 50);

  try {
    return NextResponse.json(await loadTrending(kind, limit));
  } catch (e) {
    const err = e as { code?: string; message?: string };
    console.error('[api/trending] список не прочитан:', `sqlstate=${err?.code ?? 'нет'}`, err?.message ?? String(e));
    return NextResponse.json({ error: 'Не удалось загрузить популярное' }, { status: 500 });
  }
}
