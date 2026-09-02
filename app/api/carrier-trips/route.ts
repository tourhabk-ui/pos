/**
 * GET /api/carrier-trips — витрина свободных мест в поездках перевозчиков.
 *
 * Параметры: from, to (ГГГГ-ММ-ДД; по умолчанию сегодня и +30 дней, окно не
 * больше 60), min_seats (1..60, по умолчанию 1), place_id (uuid).
 *
 * ── Ответ обязан отличать «ещё не искали» от «искали, нашли ноль» ──────────
 *
 * Урок перенесён из удалённого сторожа transfer-empty-state (02.08): поиск
 * давал ноль, экран молчал, и платформа выглядела сломанной. Сервис
 * (listPublishedTrips) различить это не может по построению; роут — может и
 * обязан: в ответе всегда `searched: true` и окно дат, по которому искали.
 * Пустой `trips` при `searched: true` — это факт «в эти дни никто не едет»,
 * и экран показывает его словами и предлагает другие даты, а не пустоту.
 *
 * Читает только через listPublishedTrips — единственное место, где стоит
 * фильтр is_published. Прямого SELECT из transfer_trips тут нет и быть не
 * должно (сторож carrier-api).
 *
 * Публичный на Edge для GET (реестр); внутри — лимит на IP, как у других
 * анонимных читалок каталога.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { listPublishedTrips } from '@/lib/transfers/service';
import { createRateLimiter } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

export const MAX_WINDOW_DAYS = 60;
export const DEFAULT_WINDOW_DAYS = 30;

const limiter = createRateLimiter({ windowMs: 60_000, max: 60 });

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const QuerySchema = z.object({
  from: z.string().regex(DATE).optional(),
  to: z.string().regex(DATE).optional(),
  min_seats: z.coerce.number().int().min(1).max(60).default(1),
  place_id: z.string().uuid().optional(),
});

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function ipOf(req: NextRequest): string {
  const h = req.headers;
  return h.get('x-real-ip') || h.get('cf-connecting-ip') || h.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}

export async function GET(request: NextRequest) {
  if (!limiter.check(ipOf(request))) {
    return NextResponse.json({ success: false, error: 'Слишком много запросов, попробуйте позже' }, { status: 429 });
  }

  const sp = request.nextUrl.searchParams;
  const parsed = QuerySchema.safeParse({
    from: sp.get('from') ?? undefined,
    to: sp.get('to') ?? undefined,
    min_seats: sp.get('min_seats') ?? undefined,
    place_id: sp.get('place_id') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: 'Некорректные параметры поиска: даты ГГГГ-ММ-ДД, min_seats 1..60, place_id uuid' },
      { status: 400 },
    );
  }

  const today = new Date();
  const from = parsed.data.from ?? isoDate(today);
  const to = parsed.data.to ?? isoDate(new Date(today.getTime() + DEFAULT_WINDOW_DAYS * 86_400_000));
  const spanDays = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
  if (!Number.isFinite(spanDays) || spanDays < 0 || spanDays > MAX_WINDOW_DAYS) {
    return NextResponse.json(
      { success: false, error: `Окно дат от 0 до ${MAX_WINDOW_DAYS} дней, «до» не раньше «от»` },
      { status: 400 },
    );
  }

  try {
    const trips = await listPublishedTrips({
      fromDate: from,
      toDate: to,
      minSeats: parsed.data.min_seats,
      placeId: parsed.data.place_id ?? null,
    });
    return NextResponse.json({
      success: true,
      searched: true,
      window: { from, to, min_seats: parsed.data.min_seats, place_id: parsed.data.place_id ?? null },
      count: trips.length,
      trips,
    });
  } catch (err) {
    console.error('[carrier-trips] list:', err instanceof Error ? err.message : err);
    // Отказ — не «ноль поездок»: экран обязан сказать «не смогли проверить».
    return NextResponse.json(
      { success: false, searched: false, error: 'Не удалось проверить поездки — попробуйте позже' },
      { status: 503 },
    );
  }
}
