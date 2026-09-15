/**
 * Форма снятой записи — для показа в очереди треков.
 *
 * ── Зачем (15.09) ─────────────────────────────────────────────────────────
 *
 * Очередь показывала запись столбцом чисел: точек, длина, состояние. Своего
 * выхода человек по ним не узнаёт — те же числа даёт и подъём на вулкан, и
 * круг по посёлку. Отвечает на «это моя запись?» форма линии, а её в очереди
 * не хранилось вовсе (904 хранит измерения и ссылку на файл).
 *
 * ── Почему это НЕ второй путь применения ──────────────────────────────────
 *
 * Здесь только чтение и только разбор: скачать файл, разобрать, отсеять точки
 * за пределами края, разрезать по провалам сигнала, проредить для показа.
 * Ни старшинства источников, ни судьи имени §13, ни транзакции — то есть
 * ничего из правил ПРИМЕНЕНИЯ, которые живут в одном месте
 * (`/api/cron/track-import-queue`) и второго экземпляра не получают.
 *
 * Разбор при этом тоже не переписан: `parseTrackFile` и `splitAtGaps` — те же
 * библиотеки, которыми считает применение. Расхождение между тем, что человек
 * увидел, и тем, что ляжет в маршрут, было бы хуже отсутствия картинки.
 *
 * ── Прореженная копия не подменяет запись ─────────────────────────────────
 *
 * `preview_line` кэшируется в очереди, чтобы не скачивать файл на каждый
 * показ, но линию маршрута из неё НЕ берут никогда: применение считает её
 * заново из файла. Иначе огрубление для экрана однажды стало бы геометрией
 * маршрута.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { parseTrackFile } from '@/lib/field/track-import';
import { splitAtGaps } from '@/lib/field/track-segments';
import { isPlausibleTrackPoint } from '@/lib/routes/track';
import { buildTrackPreview, type TrackPreview } from '@/lib/field/track-preview';

export const dynamic = 'force-dynamic';

interface Row {
  id: string;
  s3_url: string;
  preview_line: TrackPreview | null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;

  let row: Row | undefined;
  try {
    const res = await pool.query<Row>(
      `SELECT id::text AS id, s3_url, preview_line FROM route_track_imports WHERE id::text = $1`,
      [id],
    );
    row = res.rows[0];
  } catch (err) {
    const message = err instanceof Error ? err.message : 'база не ответила';
    console.error('[track-line] запись не прочиталась:', message);
    return NextResponse.json({ ok: false, error: message }, { status: 503 });
  }
  if (!row) {
    return NextResponse.json({ ok: false, error: 'Запись в очереди не найдена' }, { status: 404 });
  }

  // Уже смотрели — отдаём сохранённое. `cached` едет в ответе: «взято из
  // кэша» и «разобрано сейчас» — разные состояния, и в отладке они нужны.
  if (row.preview_line && Array.isArray(row.preview_line.pieces)) {
    return NextResponse.json({ ok: true, cached: true, preview: row.preview_line });
  }

  let fileBuf: Buffer;
  try {
    const res = await fetch(row.s3_url);
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: `Хранилище отдало ${res.status} — файл записи недоступен` },
        { status: 502 },
      );
    }
    fileBuf = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    const message = err instanceof Error ? err.message : 'сеть';
    // Отказ хранилища — это «не смог показать», а не «линии нет» (§4.0).
    // Пустая карта на этом месте соврала бы о самой записи.
    console.error('[track-line] файл не скачался:', message);
    return NextResponse.json({ ok: false, error: `Файл не скачался: ${message}` }, { status: 502 });
  }

  const parsed = parseTrackFile(fileBuf);
  const track = parsed.tracks.find(t => t.points.length >= 2) ?? null;
  if (!track) {
    return NextResponse.json(
      { ok: false, error: 'Файл разобрался, но линии в нём нет — это метки, а не трек', problems: parsed.problems },
      { status: 422 },
    );
  }

  const plausible = track.points.filter(p => isPlausibleTrackPoint(p.lat, p.lng));
  if (plausible.length < 2) {
    return NextResponse.json(
      { ok: false, error: 'После отсева точек за пределами Камчатки линии не осталось' },
      { status: 422 },
    );
  }

  const preview = buildTrackPreview(splitAtGaps(plausible));

  try {
    await pool.query(
      `UPDATE route_track_imports SET preview_line = $2::jsonb WHERE id::text = $1`,
      [id, JSON.stringify(preview)],
    );
  } catch (err) {
    // Кэш не записался — показать всё равно можем. Молчать нельзя: без строки
    // в логе «почему-то каждый раз медленно» не находится никогда.
    const message = err instanceof Error ? err.message : 'база не ответила';
    console.error('[track-line] превью не сохранилось в кэш:', message);
  }

  return NextResponse.json({ ok: true, cached: false, preview });
}
