/**
 * Связка «регистрация маршрута ↔ спутниковый трекер».
 *
 *   GET    /api/safety/tracker-links?registrationId=...  — что подключено
 *   POST   /api/safety/tracker-links                     — подключить
 *   DELETE /api/safety/tracker-links?id=...              — отозвать
 *
 * Производитель токена, который слушает `POST /api/safety/tracker/[token]`.
 * Без него приёмник был бы проводом в никуда (§10.09): адрес есть, а завести
 * его некому.
 *
 * ── Токен показывается ОДИН раз, при создании ────────────────────────────
 *
 * Дальше он в ответах не появляется — ни в списке, ни где-либо ещё. Причина
 * не в криптографии: токен и так хранится как есть, иначе приёмник не нашёл
 * бы связку. Причина в поверхности: список связок открывается на экране
 * каждый раз, и полный адрес в нём — это секрет, который лежит на виду у
 * всякого, кто заглянул через плечо в кафе или в автобусе. Потерял адрес —
 * отзови связку и заведи новую: это одно нажатие, а ротация секрета, который
 * нельзя отозвать, — вечная проблема.
 *
 * ── Чужой маршрут не подключить ──────────────────────────────────────────
 *
 * Регистрация проверяется на принадлежность вызывающему. Иначе любой
 * авторизованный пользователь смог бы завести трекер на чужой маршрут и
 * писать туда координаты — то есть двигать точку, по которой человека будут
 * искать.
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { query } from '@/lib/database';
import { requireAuth } from '@/lib/auth/middleware';

export const dynamic = 'force-dynamic';

const CreateSchema = z.object({
  registrationId: z.string().uuid(),
  label: z.string().trim().max(120).optional(),
  vendor: z.string().trim().max(60).optional(),
});

interface LinkRow {
  id: string;
  label: string | null;
  vendor: string | null;
  created_at: string;
  revoked_at: string | null;
  points_total: number;
  last_point_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
}

/** Регистрация принадлежит этому человеку? `null` — её нет или она чужая. */
async function ownRegistration(registrationId: string, userId: string): Promise<string | null> {
  const { rows } = await query<{ id: string }>(
    `SELECT id::text AS id FROM route_registrations
      WHERE id::text = $1 AND user_id::text = $2
      LIMIT 1`,
    [registrationId, userId],
  );
  return rows[0]?.id ?? null;
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const registrationId = request.nextUrl.searchParams.get('registrationId');
  if (!registrationId) {
    return NextResponse.json({ ok: false, error: 'Нужен registrationId' }, { status: 400 });
  }

  try {
    if (!(await ownRegistration(registrationId, String(auth.userId)))) {
      return NextResponse.json({ ok: false, error: 'Регистрация не найдена' }, { status: 404 });
    }

    const { rows } = await query<LinkRow>(
      `SELECT id::text AS id, label, vendor,
              created_at::text AS created_at, revoked_at::text AS revoked_at,
              points_total,
              last_point_at::text AS last_point_at,
              last_error, last_error_at::text AS last_error_at
         FROM tracker_links
        WHERE registration_id::text = $1
        ORDER BY created_at DESC`,
      [registrationId],
    );

    return NextResponse.json({
      ok: true,
      // Токена здесь нет намеренно — см. шапку.
      links: rows.map((r) => ({
        ...r,
        // «Ни одной точки» и «точки были, потом кончились» — разные беды.
        // Обе видны по паре счётчик/время, и ни одна не выдаётся за другую.
        silent: r.points_total === 0,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'база не ответила';
    console.error('[tracker-links] список не прочитался:', message);
    return NextResponse.json({ ok: false, error: message }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const body: unknown = await request.json().catch(() => null);
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: parsed.error.issues[0]?.message ?? 'Некорректное тело' },
      { status: 400 },
    );
  }

  try {
    if (!(await ownRegistration(parsed.data.registrationId, String(auth.userId)))) {
      return NextResponse.json({ ok: false, error: 'Регистрация не найдена' }, { status: 404 });
    }

    // 32 байта энтропии: токен — единственная дверь приёмника, и подбирать
    // его должно быть бессмысленно.
    const token = randomBytes(32).toString('base64url');

    const { rows } = await query<{ id: string }>(
      `INSERT INTO tracker_links (registration_id, token, label, vendor, created_by)
       VALUES ($1::uuid, $2, $3, $4, $5::uuid)
       RETURNING id::text AS id`,
      [
        parsed.data.registrationId,
        token,
        parsed.data.label?.trim() || null,
        parsed.data.vendor?.trim() || null,
        String(auth.userId),
      ],
    );

    const base = process.env.NEXT_PUBLIC_SITE_URL || 'https://vedarai.ru';
    return NextResponse.json({
      ok: true,
      id: rows[0]?.id,
      // Адрес отдаётся ЦЕЛИКОМ и только сейчас: его вбивают в настройки
      // шлюза вендора один раз.
      url: `${base}/api/safety/tracker/${token}`,
      hint: 'Вбейте этот адрес в настройки отправки вашего трекера (HTTP POST). '
        + 'Тело: {"lat": 53.01, "lng": 158.65} — время необязательно. '
        + 'Адрес показывается один раз: потеряли — отзовите связку и создайте новую.',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'база не ответила';
    console.error('[tracker-links] связка не создалась:', message);
    return NextResponse.json({ ok: false, error: message }, { status: 503 });
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const id = request.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ ok: false, error: 'Нужен id' }, { status: 400 });

  try {
    // Отзыв, а не удаление: счётчики приёма — улика для разбора «почему
    // точки перестали приходить» (миграция 985).
    const { rowCount } = await query(
      `UPDATE tracker_links l
          SET revoked_at = NOW()
         FROM route_registrations r
        WHERE l.id::text = $1
          AND r.id = l.registration_id
          AND r.user_id::text = $2
          AND l.revoked_at IS NULL`,
      [id, String(auth.userId)],
    );
    if ((rowCount ?? 0) === 0) {
      return NextResponse.json({ ok: false, error: 'Связка не найдена или уже отозвана' }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'база не ответила';
    console.error('[tracker-links] связка не отозвалась:', message);
    return NextResponse.json({ ok: false, error: message }, { status: 503 });
  }
}
