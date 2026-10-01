import { NextResponse } from 'next/server';
import { loadPublicCollections } from '@/lib/collections/list';

export const dynamic = 'force-dynamic';

/**
 * Публичные подборки. Загрузчик общий со страницей /collections —
 * lib/collections/list.ts (там же честный счёт и скрытие пустых).
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const tag = searchParams.get('tag');
  const parsed = parseInt(searchParams.get('limit') ?? '20', 10);
  const limit = Math.min(Number.isFinite(parsed) && parsed > 0 ? parsed : 20, 50);

  try {
    const collections = await loadPublicCollections({ tag, limit });
    return NextResponse.json({ collections });
  } catch (e) {
    const err = e as { code?: string; message?: string };
    console.error('[api/collections] подборки не прочитаны:', `sqlstate=${err?.code ?? 'нет'}`, err?.message ?? String(e));
    return NextResponse.json({ error: 'Не удалось загрузить подборки' }, { status: 500 });
  }
}
