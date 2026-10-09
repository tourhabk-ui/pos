/**
 * GET /video/<путь> — ролик или обложка: переадресация в хранилище.
 *
 * Пути `/video/...` записаны в базе (partners.video_url, video_clips; форму
 * держит CHECK partners_video_shape) с тех пор, как файлы лежали в
 * public/video. С 09.10 файлы в хранилище (lib/media/video-manifest.ts), и
 * страница получает прямой адрес объекта (lib/media/video-url.ts). Здесь —
 * всё, что пришло старым путём: ссылка из кэша, из чужой страницы, из
 * поверхности, которая адрес не переводит.
 *
 * Адрес строится только для файлов манифеста — не из произвольного ввода.
 * Нет в манифесте — 404; хранилище не настроено — 503 и строка в лог, а не
 * переадресация в никуда.
 */
import { NextRequest, NextResponse } from 'next/server';
import { isKnownVideoPath } from '@/lib/media/video-manifest';
import { videoSrc } from '@/lib/media/video-url';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const path = `/video/${(await params).path.join('/')}`;
  if (!isKnownVideoPath(path)) {
    return NextResponse.json({ error: 'Видео не найдено' }, { status: 404 });
  }
  const target = videoSrc(path);
  if (target === path) {
    console.error('[video] адрес в хранилище не построить: S3_BUCKET не задан', { path });
    return NextResponse.json({ error: 'Хранилище видео недоступно' }, { status: 503 });
  }
  return NextResponse.redirect(target, 302);
}
