/**
 * POST /api/safety/route-checkin — «мы ещё в пути, всё в порядке».
 *
 * Отметка на КОНКРЕТНОЙ регистрации маршрута — не путать с
 * `POST /api/safety/checkin`: тот пишет в `safety_checkins` анонимный
 * чек-ин по зоне и ни на что не влияет.
 *
 * Зачем: до 09.09 остановить лестницу эскалации можно было ровно одним
 * способом — отметить ВОЗВРАТ. Группа, которая жива и просто задерживается,
 * должна была либо соврать (закрыть маршрут и остаться без сторожа), либо
 * молчать и ждать, пока в 112 позвонят из-за неё. Колонка
 * `checkin_confirmed_at` для этого была заведена ещё миграцией 680, но
 * писать в неё было НЕКОМУ: сторож её читал, никто не заполнял.
 *
 * Отметка не отменяет тревогу, а отодвигает её на буфер
 * (`lib/safety/checkin-escalation.ts`). Обещать большее нельзя: свежая
 * отметка знает о настоящем, вчерашняя — нет.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/database';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';
import { openRegistrationForMark, markDenied } from '@/lib/safety/registration-mark';

export const dynamic = 'force-dynamic';

// Номер руководителя — второй ключ к чужой регистрации, значит подбор по нему
// должен упираться в лимит, а не в терпение.
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

  const { reg } = access;

  if (reg.completed_at) {
    return NextResponse.json({
      success: true,
      already_completed: true,
      message: `Маршрут «${reg.route_name}» уже закрыт отметкой о возвращении — напоминания не придут.`,
    });
  }

  await query(
    `UPDATE route_registrations SET checkin_confirmed_at = now() WHERE id = $1`,
    [parsed.registration_id],
  );

  return NextResponse.json({
    success: true,
    route_name: reg.route_name,
    // Формулировка намеренно не обещает тишины: лестница продолжится, если
    // группа снова пропадёт. Обещать «уведомления остановлены» было бы враньём.
    message: 'Отметка принята. Следующее напоминание придёт не раньше, чем снова истечёт срок ожидания.',
  });
}
