/**
 * POST /api/trip-groups/[id]/members — пожелания участника группы (#2226).
 *
 * AUTH: публичный by design — участник без аккаунта. Защита: rate-limit, Zod,
 * обязательное согласие на обработку данных (решение владельца 08.10: согласие
 * каждого участника), потолок участников в группе. О здоровье — только флаги
 * без диагнозов; свободного текста нет вовсе.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createRateLimiter, getTrustedClientIp } from '@/lib/rate-limit';
import { buildConsentRecord } from '@/lib/legal/pd-consent';
import { addMember, MAX_GROUP_MEMBERS } from '@/lib/planner/trip-groups';
import { GROUP_INTEREST_KEYS } from '@/lib/planner/group-merge';

export const dynamic = 'force-dynamic';

const limiter = createRateLimiter({ windowMs: 60_000, max: 5 });

const Schema = z.object({
  interests:        z.array(z.string()).max(13).transform((a) => a.filter((k) => GROUP_INTEREST_KEYS.includes(k))),
  fitness:          z.enum(['beginner', 'moderate', 'active'], { message: 'Выберите уровень подготовки' }),
  no_hard_climbs:   z.boolean().default(false),
  seasickness:      z.boolean().default(false),
  limited_mobility: z.boolean().default(false),
  youngest_child:   z.number().int().min(0, 'Возраст ребёнка — от 0').max(17, 'Возраст ребёнка — до 17').nullable().default(null),
  budget:           z.enum(['economy', 'comfort', 'premium'], { message: 'Выберите бюджет' }),
  pd_consent:       z.literal(true, { message: 'Нужно согласие на обработку персональных данных' }),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ip = getTrustedClientIp(req.headers);
  if (!limiter.check(ip)) {
    return NextResponse.json({ success: false, error: 'Слишком много запросов. Попробуйте через минуту.' }, { status: 429 });
  }
  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ success: false, error: 'Неверный формат запроса' }, { status: 400 });
  }
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json({ success: false, error: first?.message ?? 'Неверные данные формы', field: first?.path?.[0] }, { status: 400 });
  }
  const d = parsed.data;
  if (d.interests.length === 0) {
    return NextResponse.json({ success: false, error: 'Отметьте хотя бы одно занятие', field: 'interests' }, { status: 400 });
  }
  const consent = buildConsentRecord(d.pd_consent, ip, 'trip-group');
  if (!consent) return NextResponse.json({ success: false, error: 'Нужно согласие на обработку персональных данных' }, { status: 400 });

  const { id } = await params;
  const result = await addMember(id, {
    interests: d.interests, fitness: d.fitness, noHardClimbs: d.no_hard_climbs, seasickness: d.seasickness,
    limitedMobility: d.limited_mobility, youngestChild: d.youngest_child, budget: d.budget,
  }, consent);
  if (result === 'missing') return NextResponse.json({ success: false, error: 'Группа не найдена или её срок истёк.' }, { status: 404 });
  if (result === 'full') return NextResponse.json({ success: false, error: `В группе уже ${MAX_GROUP_MEMBERS} участников — больше не принимаем.` }, { status: 409 });
  if (result === 'failed') return NextResponse.json({ success: false, error: 'Не удалось сохранить пожелания, попробуйте через минуту.' }, { status: 503 });
  return NextResponse.json({ success: true });
}
