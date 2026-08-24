/**
 * POST /api/cron/backfill-partner-profile — вернуть профиль тем, кого заперла
 * сломанная регистрация.
 *
 * ЗАЧЕМ ОТДЕЛЬНАЯ РУЧКА. Перепись locked-out-partners (24.08) нашла двух
 * человек с аккаунтом, но без партнёрского профиля: агент, и человек,
 * пытавшийся зарегистрироваться сразу agent+guide+transfer. Причина — 42P08
 * в INSERT профиля (CLAUDE.md §4.0, случай 24.08), который не выполнялся
 * НИКОГДА до правки того же дня. Аккаунт у них создан, значит потеря
 * обратима: не хватает только строки в `partners`.
 *
 * ПОЧЕМУ НЕ ПРОСТО SQL С РАННЕРА. `ensurePartnerForRole`
 * (`lib/auth/partner-profile.ts`) — единственное место, которое знает, как
 * собрать профиль правильно (имя и почта из `users`, WHERE NOT EXISTS от
 * гонки). Заводить второй способ создания профиля — плодить второе место,
 * которое завтра разойдётся с первым.
 *
 * ПРАВИЛА, ТЕ ЖЕ ЧТО У tour-pickup / place-coords:
 * - `source` и `why` обязательны и без умолчаний — через месяц «кто велел
 *   восстановить именно этих двоих» будет неоткуда взять;
 * - сухой прогон по умолчанию — писать надо попросить вслух;
 * - партия не больше десяти;
 * - идемпотентно по построению: `ensurePartnerForRole` сам не создаёт
 *   вторую строку, если профиль уже есть — повторный вызов безопасен.
 *
 * Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { ensurePartnerForRole } from '@/lib/auth/partner-profile';

export const dynamic     = 'force-dynamic';
export const maxDuration = 30;

export const LIVE_BATCH_MAX = 10;

const ItemSchema = z.object({
  user_id: z.string().uuid(),
  role: z.enum(['operator', 'guide', 'transfer', 'agent', 'stay', 'gear']),
});

const BodySchema = z.object({
  source: z.string().trim().min(3, 'Назовите источник').max(200),
  why: z.string().trim().min(3, 'Назовите причину').max(300),
  dry_run: z.boolean().default(true),
  items: z.array(ItemSchema).min(1).max(LIVE_BATCH_MAX),
});

export async function POST(req: NextRequest) {
  const secret = getCronSecret(req);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let parsed: z.infer<typeof BodySchema>;
  try {
    parsed = BodySchema.parse(await req.json());
  } catch (err) {
    const msg = err instanceof z.ZodError ? err.issues[0]?.message ?? 'Некорректные данные' : 'Некорректные данные';
    return NextResponse.json({ probe: 'backfill_partner_profile_v1', error: msg }, { status: 400 });
  }

  const { source, why, dry_run, items } = parsed;

  const results: Array<{
    user_id: string; role: string; would_create: boolean;
    profile_id: string | null; already_had_profile: boolean;
  }> = [];

  for (const item of items) {
    if (dry_run) {
      results.push({
        user_id: item.user_id, role: item.role,
        would_create: true, profile_id: null, already_had_profile: false,
      });
      continue;
    }
    const profileId = await ensurePartnerForRole(item.user_id, item.role);
    results.push({
      user_id: item.user_id, role: item.role,
      would_create: false, profile_id: profileId, already_had_profile: false,
    });
  }

  return NextResponse.json({
    ok: true,
    probe: 'backfill_partner_profile_v1',
    source,
    why,
    dry_run,
    checked: items.length,
    results,
  });
}
