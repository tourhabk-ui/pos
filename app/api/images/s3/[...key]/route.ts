import { NextResponse } from 'next/server';
import { s3PublicUrl } from '@/lib/storage/s3';
import { photoKeyOf } from '@/lib/images/photo-key';

export const dynamic = 'force-dynamic';

interface Props { params: Promise<{ key: string[] }> }

/**
 * GET /api/images/s3/photos/<…>.jpg — снимок из хранилища по ключу.
 *
 * Зачем (14.10). Статья «Летописи Камчатки» — константа в коде и собирается
 * при сборке образа (generateStaticParams), а адрес объекта хранилища
 * собирается из S3_BUCKET, которого на сборке может не быть. Страница ставит
 * этот адрес, а сервер на запросе отвечает редиректом на объект — тот же
 * приём, что у снимков мест (/api/images/route, /api/images/place-gallery).
 *
 * Только ключи под `photos/` — снимки, залитые media-to-s3 (scripts/
 * media-to-s3.ts) вместе с автором и лицензией в миграции; только `.jpg`,
 * строчная латиница, без `..`. Чужой префикс (`places/<uuid>/` уборки сирот,
 * пакеты карты) этим путём не открывается: адресуемо ровно то, что
 * публикуется. Бакета нет — 404, а не редирект в корень хранилища.
 */
export async function GET(_request: Request, { params }: Props): Promise<NextResponse> {
  const { key: parts } = await params;
  const key = photoKeyOf(parts ?? []);
  if (!key) return NextResponse.json({ error: 'Снимок не найден' }, { status: 404 });
  const url = s3PublicUrl(key);
  if (!url) return NextResponse.json({ error: 'Хранилище не настроено' }, { status: 404 });
  return NextResponse.redirect(url, {
    status: 302,
    headers: { 'Cache-Control': 'public, max-age=86400' },
  });
}
