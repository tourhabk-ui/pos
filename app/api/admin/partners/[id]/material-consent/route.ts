/**
 * /api/admin/partners/[id]/material-consent — согласие партнёра на
 * использование материалов его сайта (миграция 1321, решение владельца 23.10).
 *
 *   GET   — история согласий (новые сверху) и состояние ссылки;
 *   POST  — выпустить одноразовую ссылку на 30 дней: ключ показывается один
 *           раз, в базе только хэш; прежняя ссылка гаснет;
 *   PATCH — отозвать действующее согласие со слов партнёра, причина не
 *           короче 8 знаков (держит и CHECK в базе).
 *
 * AUTH: requireAdmin (и Edge-гейт /api/admin/*). Отказ базы — 503 с SQLSTATE в
 * логе: «не смогли прочитать» не выдаётся за «согласия нет» (§4.0).
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { getPublicBaseUrl } from '@/lib/config';
import {
  issueConsentInvite, loadConsentInvite, loadPartnerConsents, revokeMaterialsConsent,
} from '@/lib/partners/material-consent';
import { partnerConsentUrl } from '@/lib/partners/material-consent-rules';
import { logText } from '@/lib/log/log-text';

export const dynamic = 'force-dynamic';

const IdSchema = z.string().uuid();
const RevokeBody = z.object({ reason: z.string().trim().min(8, 'Причина отзыва — не короче 8 знаков: чьи слова и когда').max(500) });

type Ctx = { params: Promise<{ id: string }> };

const fail = (status: number, error: string) => NextResponse.json({ success: false, error }, { status });

function logFailure(what: string, err: unknown): void {
  const code = (err as { code?: unknown } | null)?.code;
  console.error(
    `[admin/material-consent] ${what}: sqlstate=${typeof code === 'string' ? code : 'нет'}`,
    logText(err instanceof Error ? err.message : err, 200),
  );
}

async function partnerId(req: NextRequest, ctx: Ctx): Promise<string | NextResponse> {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const { id } = await ctx.params;
  const parsed = IdSchema.safeParse(id);
  return parsed.success ? parsed.data : fail(400, 'Некорректный идентификатор партнёра');
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const id = await partnerId(req, ctx);
  if (id instanceof NextResponse) return id;
  try {
    const [consents, invite] = await Promise.all([loadPartnerConsents(id), loadConsentInvite(id)]);
    return NextResponse.json({ success: true, data: { consents, invite } });
  } catch (err) {
    logFailure('не прочитано', err);
    return fail(503, 'Не смогли прочитать согласия партнёра — сбой базы. Это не значит, что согласия нет.');
  }
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const id = await partnerId(req, ctx);
  if (id instanceof NextResponse) return id;
  try {
    const res = await issueConsentInvite(id);
    if (!res.ok) return fail(404, 'Партнёр не найден');
    const url = partnerConsentUrl(getPublicBaseUrl(), res.key);
    const text =
      `Здравствуйте! Это Ведар (vedarai.ru). Чтобы мы показывали туристам фото, логотип и описание «${res.partnerName}» ` +
      `с вашего сайта, нужно ваше согласие. Прочитайте текст и подпишите по ссылке — это займёт минуту:\n${url}\n` +
      'Ссылка личная и действует 30 дней. Отозвать согласие можно в любой момент сообщением нам.';
    return NextResponse.json({ success: true, data: { url, text, expires_at: res.expiresAt, shown_once: true } });
  } catch (err) {
    logFailure('ссылка не выпущена', err);
    return fail(503, 'Не смогли выпустить ссылку — сбой базы. Попробуйте позже.');
  }
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const id = await partnerId(req, ctx);
  if (id instanceof NextResponse) return id;
  let raw: unknown;
  try { raw = await req.json(); } catch { return fail(400, 'Неверный формат запроса'); }
  const parsed = RevokeBody.safeParse(raw);
  if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? 'Неверные данные');
  try {
    const res = await revokeMaterialsConsent(id, parsed.data.reason);
    if (!res.ok) return fail(409, 'Действующего согласия у партнёра нет — отзывать нечего.');
    return NextResponse.json({ success: true, data: { revoked: res.revoked } });
  } catch (err) {
    logFailure('отзыв не записан', err);
    return fail(503, 'Не смогли записать отзыв — сбой базы. Попробуйте позже.');
  }
}
