/**
 * POST /api/trip-groups/[id]/plan — собрать план группы (#2226).
 *
 * Сводка пожеланий (lib/planner/group-merge) → тот же движок, что у планера и
 * Кузьмича → черновик плана, который открывается на /trip/<id>. Пожелания
 * не меняются; собрать заново можно после новых участников.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createRateLimiter, getTrustedClientIp } from '@/lib/rate-limit';
import { buildGroupPlan } from '@/lib/planner/trip-groups';

export const dynamic = 'force-dynamic';

// Сборка плана тяжелее записи — потолок строже.
const limiter = createRateLimiter({ windowMs: 60_000, max: 3 });

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!limiter.check(getTrustedClientIp(req.headers))) {
    return NextResponse.json({ success: false, error: 'Слишком много запросов. Попробуйте через минуту.' }, { status: 429 });
  }
  const { id } = await params;
  const r = await buildGroupPlan(id);
  switch (r.kind) {
    case 'planned': return NextResponse.json({ success: true, data: { plan_id: r.draftId, url: `/trip/${r.draftId}` } });
    case 'empty': return NextResponse.json({ success: false, error: 'В группе ещё нет ни одного пожелания.' }, { status: 422 });
    case 'no_days': return NextResponse.json({ success: false, error: 'По пожеланиям группы на эти даты не собрался ни один день: ограничения исключили все занятия или не сезон. Измените пожелания или даты.' }, { status: 422 });
    case 'missing': return NextResponse.json({ success: false, error: 'Группа не найдена или её срок истёк.' }, { status: 404 });
    default: return NextResponse.json({ success: false, error: 'План сейчас не собрался, попробуйте через минуту.' }, { status: 503 });
  }
}
