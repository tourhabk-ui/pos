/**
 * GET /api/trip-groups/[id] — сводка группы (#2226): даты, сколько участников,
 * сведённые пожелания и конфликты. Строк участников здесь нет и быть не должно:
 * ссылку группы видит каждый, у кого она есть (сторож trip-groups-no-member-rows).
 */
import { NextRequest, NextResponse } from 'next/server';
import { groupSummary } from '@/lib/planner/trip-groups';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const read = await groupSummary(id);
  if (read.kind === 'missing') return NextResponse.json({ success: false, error: 'Группа не найдена или её срок истёк.' }, { status: 404 });
  if (read.kind === 'failed') return NextResponse.json({ success: false, error: 'Группа сейчас не прочиталась, попробуйте через минуту.' }, { status: 503 });
  return NextResponse.json({ success: true, data: read.summary });
}
