import { NextResponse } from 'next/server';
import { s3PublicUrl } from '@/lib/storage/s3';
import { photoKeyOf, photoTypeOf } from '@/lib/images/photo-key';
import { serveStoredObject } from '@/lib/images/serve-stored';

export const dynamic = 'force-dynamic';

interface Props { params: Promise<{ key: string[] }> }

/** Сутки в браузере, неделя «устаревшим, пока освежается»: снимок по ключу меняется редко. */
const CACHE = 'public, max-age=86400, stale-while-revalidate=604800';

/**
 * GET /api/images/s3/photos/<…>.jpg — снимок из хранилища по ключу.
 *
 * Зачем адрес на нашем домене (14.10). Статья «Летописи Камчатки» — константа
 * в коде и собирается при сборке образа (generateStaticParams), а адрес объекта
 * хранилища собирается из S3_BUCKET, которого на сборке может не быть.
 *
 * Байты — с нашего домена, а не редиректом (29.10). До этого дня сервер
 * отвечал 302 на s3.twcstorage.ru, и снимок грузил браузер туриста со второго
 * домена. Владелец 29.10 с телефона: «лагуна экспедиция фото до сих пор нет» —
 * страница vedarai.ru открылась, а 133 снимка «Лагуны Экспедиции», которые из
 * песочницы и браузера разработки отвечали 200, на его телефоне остались
 * пустыми рамками. Второй домен — вторая точка отказа для того, кто в крае:
 * мобильная сеть или VPN, пропускающие сайт и не пропускающие хранилище,
 * оставляют страницу без снимков. Теперь сервер сам читает объект и отдаёт
 * его телом ответа; браузер видит один домен.
 *
 * Только ключи под `photos/` — снимки, залитые media-to-s3 (scripts/
 * media-to-s3.ts); `.jpg`, `.jpeg`, `.png`, `.webp` (с 08.11: уменьшенные
 * копии и логотипы партнёров), строчная латиница, без `..`. Чужой префикс (`places/<uuid>/` уборки сирот,
 * пакеты карты) этим путём не открывается: адресуемо ровно то, что
 * публикуется. Бакета нет — 404. Хранилище ответило «нет объекта» — 404;
 * не ответило или ответило ошибкой — 502 и строка в лог (§4.0: «не смог» не
 * выдаётся за «нет»).
 */
export async function GET(request: Request, { params }: Props): Promise<Response> {
  const { key: parts } = await params;
  const key = photoKeyOf(parts ?? []);
  if (!key) return NextResponse.json({ error: 'Снимок не найден' }, { status: 404 });
  const url = s3PublicUrl(key);
  if (!url) return NextResponse.json({ error: 'Хранилище не настроено' }, { status: 404 });

  return serveStoredObject(url, request, { cache: CACHE, fallbackType: photoTypeOf(key), logScope: 'images/s3' });
}
