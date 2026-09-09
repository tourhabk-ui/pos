/**
 * POST /api/safety/mchs-informed — «мы сами сообщили в МЧС».
 *
 * Экстренный контакт, позвонивший в 112, до 09.09 не мог сказать об этом
 * платформе НИЧЕМ, кроме отметки о возвращении, — то есть соврав, что группа
 * вышла, и выключив сторожа ровно тогда, когда он нужен. Возврат и обращение
 * в МЧС — разные события, и теперь у них разные отметки.
 *
 * Отметка НЕ гасит шаг «mchs» лестницы: самоотчёт человека не равен
 * подтверждению того, что заявку приняли (§4.0 — «сообщил» и «приняли» это
 * не одно состояние). Дежурный увидит предупреждение о возможном дубле в
 * тексте тревоги, а не отсутствие тревоги.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/database';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';
import { openRegistrationForMark, markDenied } from '@/lib/safety/registration-mark';

export const dynamic = 'force-dynamic';

const limiter = createRateLimiter({ windowMs: 60_000, max: 10 });

const BodySchema = z.object({
  registration_id: z.string().uuid(),
  leader_phone: z.string().max(30).optional(),
});

export async function POST(request: NextRequest) {
  if (!limiter.check(getClientIp(request.headers))) {
    return NextResponse.json({ success: false, error: 'Слишком часто — подождите минуту' }, { status: 429 });
  }

  let parsed: z.infer<typeof BodySchema>;
  try {
    parsed = BodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ success: false, error: 'Некорректные данные' }, { status: 400 });
  }

  const access = await openRegistrationForMark(request, parsed.registration_id, parsed.leader_phone);
  if (!access.ok) return markDenied(access);

  // COALESCE: первая отметка и есть время обращения. Переписывать её повторным
  // нажатием нельзя — время звонка в 112 это факт, а не состояние кнопки.
  const { rows } = await query<{ mchs_informed_at: string }>(
    `UPDATE route_registrations
        SET mchs_informed_at = COALESCE(mchs_informed_at, now())
      WHERE id = $1
      RETURNING mchs_informed_at`,
    [parsed.registration_id],
  );

  return NextResponse.json({
    success: true,
    mchs_informed_at: rows[0]?.mchs_informed_at ?? null,
    message:
      'Отмечено: в МЧС сообщили. Маршрут это не закрывает — когда группа вернётся, отметьте возвращение.',
  });
}
