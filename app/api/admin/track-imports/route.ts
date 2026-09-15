/**
 * Очередь снятых в поле треков — для человека, а не для крона.
 *
 * ── Зачем заведён (15.09) ─────────────────────────────────────────────────
 *
 * Владелец: «я сам записывал трек» — и путь к месту не появился. Разбор
 * показал, что запись цела: файл в S3, строка в `route_track_imports` со
 * статусом pending. Но ПОСМОТРЕТЬ её было неоткуда: единственный вход —
 * `GET /api/cron/track-import-queue` с секретом крона в заголовке. Человек,
 * прошедший маршрут и снявший трек, увидеть свою запись не мог.
 *
 * Это та же болезнь, которую `field-check-queue` уже лечил для
 * `route_field_checks`: «форма, чей результат нельзя посмотреть, — это не
 * форма, а способ потерять чужой труд». Здесь она вернулась на треках.
 *
 * ── Почему применение НЕ переписано здесь ─────────────────────────────────
 *
 * Правила применения сложные и уже написаны один раз: старшинство источника
 * геометрии, разрез по провалам сигнала, отсев точек за пределами края,
 * судья имени §13 для нового маршрута, транзакция с созданием маршрута.
 * Написать их второй раз значило бы завести второе правило — они разойдутся
 * при первой же правке, как уже расходились ширина карточки (девятнадцать
 * мест) и стандарт линии (три экрана).
 *
 * Поэтому POST здесь — ТОНКИЙ проброс к тому же обработчику: он добавляет
 * секрет крона на сервере (клиенту секрет не отдаётся никогда) и отдаёт
 * ответ как есть. Одна реализация, два входа: крон по секрету, человек по
 * админскому JWT.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { POST as applyTrack } from '@/app/api/cron/track-import-queue/route';

export const dynamic = 'force-dynamic';

interface Row {
  id: string;
  created_at: string;
  status: string;
  source_name: string | null;
  format: string | null;
  points: number | null;
  length_km: string | null;
  note: string | null;
  trip_tag: string | null;
  matched_route_id: string | null;
  matched_route_title: string | null;
  off_by_km: string | null;
}

const num = (v: string | null): number | null => (v == null ? null : Number(v));

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const sp = request.nextUrl.searchParams;
  const statusRaw = sp.get('status') ?? 'pending';
  const status = ['pending', 'applied', 'rejected', 'all'].includes(statusRaw) ? statusRaw : 'pending';
  const rawLimit = parseInt(sp.get('limit') ?? '40', 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 40;

  try {
    const { rows } = await pool.query<Row>(
      `SELECT t.id::text AS id, t.created_at::text AS created_at, t.status,
              t.source_name, t.format, t.points, t.length_km::text AS length_km,
              t.note, t.trip_tag,
              t.matched_route_id::text AS matched_route_id,
              r.title AS matched_route_title,
              t.off_by_km::text AS off_by_km
         FROM route_track_imports t
         LEFT JOIN kamchatka_routes r ON r.id = t.matched_route_id
        WHERE ($1 = 'all' OR t.status = $1)
        ORDER BY t.created_at DESC
        LIMIT $2`,
      [status, limit],
    );

    return NextResponse.json({
      ok: true,
      status,
      items: rows.map((r) => ({
        id: r.id,
        created_at: r.created_at,
        status: r.status,
        source_name: r.source_name,
        format: r.format,
        points: r.points,
        length_km: num(r.length_km),
        note: r.note,
        trip_tag: r.trip_tag,
        // Подсказка, а не вердикт: matched_route_id подбирает БЛИЖАЙШУЮ
        // геометрией запись, а не тот маршрут, который человек фактически
        // шёл. Показываем вместе с расхождением, решение — за человеком.
        matched: r.matched_route_id
          ? { id: r.matched_route_id, title: r.matched_route_title, off_by_km: num(r.off_by_km) }
          : null,
      })),
    });
  } catch (err) {
    // Отказ базы не выдаётся за «очередь пуста»: пустой список и сломанный
    // запрос — разные состояния (§4.0).
    const message = err instanceof Error ? err.message : 'Ошибка чтения очереди';
    console.error('[track-imports] очередь не прочиталась:', message);
    return NextResponse.json({ ok: false, error: message }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const secret = process.env.CRON_SECRET ?? '';
  if (!secret) {
    return NextResponse.json(
      { success: false, error: 'CRON_SECRET не задан на сервере — применение недоступно' },
      { status: 503 },
    );
  }

  const body = await request.text();
  const forwarded = new NextRequest(new URL('/api/cron/track-import-queue', request.url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', authorization: `Bearer ${secret}` },
    body,
  });
  return applyTrack(forwarded);
}
