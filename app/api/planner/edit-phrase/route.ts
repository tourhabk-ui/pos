/**
 * POST /api/planner/edit-phrase — правка готового плана фразой (фича 5
 * супер-планера, 23.11).
 *
 * Без модели: фраза разбирается правилами (lib/planner/phrase-edit), каждая
 * правка идёт через тот же путь, что MCP `edit_trip_plan`: `readPlanEdit` →
 * `applyPlanEdit`. Остальные дни не трогаются, у туров, сменивших дату или
 * группу, места и цена перечитываются движком правки (наличие — из БД, без
 * кэша). Всё или ничего: если не прошла одна правка фразы, план не меняется.
 *
 * Вход: { phrase, params, days } — план, который человек видит на экране.
 * Ответ: { success, plan, said, notes, warnings, toursTouched, total } или
 * { success: false, error }.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { plannerSession } from '@/lib/planner/require-session';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';
import { parsePlanPhrase, resolveIntent } from '@/lib/planner/phrase-edit';
import { applyPlanEdit, planEstimate, type EditablePlan, type TouchedTour } from '@/lib/planner/plan-edit';
import { readPlanEdit } from '@/lib/kuzmich/trip-plan-tool';
import { ACTIVITY_NAMES } from '@/lib/planner/constants';
import type { DayPlan } from '@/lib/planner/engine';

export const dynamic = 'force-dynamic';

const limiter = createRateLimiter({ windowMs: 60_000, max: 20 });

const ISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Body = z.object({
  phrase: z.string().min(1).max(300),
  params: z.object({
    interests: z.array(z.string().max(40)).max(20),
    arrivalDate: ISO,
    departureDate: ISO,
    adults: z.number().int().min(1).max(30),
    children: z.array(z.number().int().min(0).max(17)).max(10),
    budgetTier: z.enum(['economy', 'comfort', 'premium']),
    travelStyle: z.enum(['self', 'operator', 'mixed']).optional(),
    restDays: z.number().int().min(0).max(14).optional(),
  }),
  days: z.array(z.object({ day: z.number().int().min(1).max(60), type: z.string().max(20) }).passthrough()).min(1).max(40),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await plannerSession(req);
  if (session instanceof NextResponse) return session;
  if (!limiter.check(`${session.userId}:${getClientIp(req.headers)}`)) {
    return NextResponse.json({ success: false, error: 'Слишком много правок подряд — подождите минуту.' }, { status: 429 });
  }
  const parsedBody = Body.safeParse(await req.json().catch(() => null));
  if (!parsedBody.success) {
    return NextResponse.json({ success: false, error: 'План или фраза пришли не целиком — обновите страницу.' }, { status: 400 });
  }
  const { phrase, params } = parsedBody.data;
  const phraseParse = parsePlanPhrase(phrase);
  if (!phraseParse.ok) return NextResponse.json({ success: false, error: phraseParse.error });

  const before: EditablePlan = { params, days: parsedBody.data.days as unknown as DayPlan[] };
  let plan = before;
  const said: string[] = [];
  const notes: string[] = [];
  const warnings: string[] = [];
  const toursTouched: TouchedTour[] = [];
  try {
    for (const intent of phraseParse.intents) {
      const resolved = resolveIntent(intent, plan.days, ACTIVITY_NAMES);
      if (!resolved.ok) return NextResponse.json({ success: false, error: `${resolved.error} План не менял.` });
      said.push(resolved.said);
      for (const args of resolved.args) {
        const edit = readPlanEdit(args);
        if (!edit.ok) return NextResponse.json({ success: false, error: `${edit.error} План не менял.` });
        const result = await applyPlanEdit(plan, edit.edit);
        if (!result.ok) return NextResponse.json({ success: false, error: `Правку «${resolved.said}» не сделал: ${result.reason} План не менял.` });
        plan = result.plan;
        notes.push(result.note);
        for (const w of result.warnings ?? []) if (!warnings.includes(w)) warnings.push(w);
        toursTouched.push(...(result.toursTouched ?? []));
      }
    }
  } catch (err) {
    console.error('[planner/edit-phrase] правка не посчиталась:', err instanceof Error ? err.message : String(err));
    return NextResponse.json({ success: false, error: 'Правку посчитать не удалось — план не менял. Попробуйте ещё раз.' }, { status: 500 });
  }
  return NextResponse.json({
    success: true,
    plan,
    said,
    notes,
    warnings,
    toursTouched,
    total: { before: planEstimate(before).total, after: planEstimate(plan).total },
  });
}
