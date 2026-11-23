/**
 * Наценка оператора на выходные (сб, вс) — K.ai B1.
 * GET — туры, действующая наценка и просьба о новой; POST { tourId, percent
 * 1..30 } — попросить; DELETE ?ruleId= — убрать одно правило (неодобренное —
 * сразу, действующее — просьбой), DELETE ?tourId= — убрать все наценки тура.
 * Цены — право can_edit_prices (как скидки). Наценка выходит на сайт после
 * проверки администратором (слово владельца 23.11).
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { managerMay, permissionDenied, requireOperatorTeam } from '@/lib/operators/team-access';
import { pool } from '@/lib/db-pool';
import { transaction } from '@/lib/database';
import { MAX_OPERATOR_MARKUP } from '@/lib/tours/operator-discount';
import { listWeekendMarkups, removeWeekendMarkupRule, setWeekendMarkup } from '@/lib/tours/operator-markup';

export const dynamic = 'force-dynamic';

const SaveSchema = z.object({
  tourId: z.coerce.number().int().positive(),
  percent: z.coerce.number().int().min(1).max(MAX_OPERATOR_MARKUP),
});

/** Что сказать владельцу после снятия — словами исхода. */
const REMOVED_WORDS = {
  // Верно и когда убрали неодобренную просьбу, и когда убирать было нечего.
  withdrawn: 'Готово: неодобренной наценки больше нет, цена на сайте не менялась.',
  removal_pending: 'Просьба снять наценку отправлена на проверку. До решения администратора наценка действует.',
} as const;

function failed(what: string, err: unknown) {
  const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '?';
  console.error(`[hub/operator/weekend-markup] ${what} (SQLSTATE ${code})`);
}

export async function GET(request: NextRequest) {
  const auth = await requireOperatorTeam(request);
  if (auth instanceof NextResponse) return auth;
  try {
    return NextResponse.json({ success: true, data: await listWeekendMarkups(pool, auth.partnerId) });
  } catch (err) {
    failed('список не отдан', err);
    return NextResponse.json({ success: false, error: 'Не удалось прочитать наценки' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireOperatorTeam(request);
  if (auth instanceof NextResponse) return auth;
  if (!managerMay(auth.access, 'can_edit_prices')) return permissionDenied('can_edit_prices');
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ success: false, error: 'Некорректный JSON' }, { status: 400 });
  }
  const parsed = SaveSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: `Наценка — целое число от 1 до ${MAX_OPERATOR_MARKUP}%` }, { status: 400 });
  }
  try {
    // Наценка меняет цену на сайте — выходит она после проверки администратором
    // (слово владельца 23.11). Дверь берёт строку тура под замок: транзакция.
    const done = await transaction((client) => setWeekendMarkup(
      client, auth.partnerId, [parsed.data.tourId], parsed.data.percent,
      z.string().uuid().safeParse(auth.userId).success ? auth.userId : null,
    ));
    if (done.tours.length === 0) return NextResponse.json({ success: false, error: 'Тур не найден' }, { status: 404 });
    const pending = done.pending.length > 0;
    return NextResponse.json({
      success: true,
      state: pending ? 'pending' : 'already_live',
      message: pending
        ? 'Наценка отправлена на проверку. Туристы увидят её после одобрения администратором.'
        : 'Такая наценка уже действует.',
    }, { status: pending ? 201 : 200 });
  } catch (err) {
    failed('наценка не сохранена', err);
    return NextResponse.json({ success: false, error: 'Не удалось сохранить наценку' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireOperatorTeam(request);
  if (auth instanceof NextResponse) return auth;
  if (!managerMay(auth.access, 'can_edit_prices')) return permissionDenied('can_edit_prices');
  const ruleId = request.nextUrl.searchParams.get('ruleId');
  try {
    if (ruleId !== null) {
      // Одно правило: «отозвать просьбу» не должно заодно просить снять действующую наценку.
      if (!/^\d{1,18}$/.test(ruleId)) return NextResponse.json({ success: false, error: 'Наценка не найдена' }, { status: 404 });
      const removed = await transaction((client) => removeWeekendMarkupRule(client, auth.partnerId, ruleId));
      if (removed.outcome === 'not_found') return NextResponse.json({ success: false, error: 'Наценка не найдена' }, { status: 404 });
      return NextResponse.json({ success: true, state: removed.outcome, message: REMOVED_WORDS[removed.outcome] });
    }
    const tourId = Number(request.nextUrl.searchParams.get('tourId'));
    if (!Number.isInteger(tourId) || tourId <= 0) return NextResponse.json({ success: false, error: 'ruleId или tourId обязателен' }, { status: 400 });
    const done = await transaction((client) => setWeekendMarkup(client, auth.partnerId, [tourId], null));
    if (done.tours.length === 0) return NextResponse.json({ success: false, error: 'Тур не найден' }, { status: 404 });
    const state = done.pending.length > 0 ? 'removal_pending' : 'withdrawn';
    return NextResponse.json({ success: true, state, message: REMOVED_WORDS[state] });
  } catch (err) {
    failed('наценка не снята', err);
    return NextResponse.json({ success: false, error: 'Не удалось снять наценку' }, { status: 500 });
  }
}
