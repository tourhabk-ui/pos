/**
 * lib/crm/partner-context.ts — чей кабинет: партнёр вошедшего человека.
 *
 * До CRM у каждой роли был свой способ найти «своего партнёра», и исходы у
 * них расходились: оператору строка `partners` заводилась на лету прямо в
 * GET, гиду отдавался null, прокат глушил отказ базы пустым `catch` и читал
 * его как «профиля нет», агент ключевался по `users.id`, а не по
 * `partners.id`. CRM одна на шесть ролей, и правило у неё одно (#2325).
 *
 * Три исхода (§4.0): партнёр найден / партнёра нет (с причиной) / «не смог
 * проверить» — база не ответила; последнее не равно «нет профиля»: роут
 * отвечает 503, а не 403. Ничего не создаёт: CRM читает профиль, а не
 * заводит его.
 *
 * `lib/auth.ts` не трогается (§7): CRM идёт через `lib/auth/middleware`,
 * эта семья гардов знает роли stay и gear.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/middleware';
import { AGENT_NOT_APPROVED_MESSAGE } from '@/lib/auth/agent-approval';
import { PARTNER_ROLES } from '@/lib/auth/role-routes';
import { pool } from '@/lib/db-pool';

export type PartnerCategory = (typeof PARTNER_ROLES)[number];

/** Роль токена → категория профиля. transfer_operator — устаревшее имя роли перевозчика. */
export const ROLE_TO_CATEGORY: Readonly<Record<string, PartnerCategory>> = {
  operator: 'operator',
  guide: 'guide',
  transfer: 'transfer',
  transfer_operator: 'transfer',
  agent: 'agent',
  stay: 'stay',
  gear: 'gear',
};

/**
 * Положена ли партнёрской записи CRM, когда партнёр опознан не входом в
 * кабинет, а привязанным чатом или ключом MCP: роль из шести и, для агента,
 * одобренный профиль — то же правило, что у partnerContextFor ниже. NULL —
 * CRM этой записи не положена.
 */
export function crmCategoryFor(category: string, profileStatus: string | null): PartnerCategory | null {
  const known = (PARTNER_ROLES as readonly string[]).includes(category) ? (category as PartnerCategory) : null;
  if (known === 'agent' && profileStatus !== 'approved') return null;
  return known;
}

export type PartnerContext =
  | { outcome: 'ok'; partnerId: string; category: PartnerCategory; userId: string }
  | { outcome: 'none'; reason: 'role' | 'profile' | 'not_approved' }
  | { outcome: 'unavailable'; reason: string };

export type PartnerContextOk = Extract<PartnerContext, { outcome: 'ok' }>;

interface Queryable {
  query: typeof pool.query;
}

export async function partnerContextFor(
  userId: string,
  role: string | null | undefined,
  db: Queryable = pool,
): Promise<PartnerContext> {
  const category = role ? ROLE_TO_CATEGORY[role] : undefined;
  if (!category) return { outcome: 'none', reason: 'role' };
  try {
    // ORDER BY: уникального индекса (user_id, category) миграции не заводят,
    // и при задвоенном профиле LIMIT 1 без порядка отдавал бы разные строки
    // от запроса к запросу (тот же довод, что в lib/auth/stay-helpers.ts).
    const { rows } = await db.query<{ id: string; profile_status: string | null }>(
      `SELECT id, profile_status
         FROM partners
        WHERE user_id = $1 AND category = $2
        ORDER BY created_at ASC NULLS LAST, id ASC
        LIMIT 1`,
      [userId, category],
    );
    const row = rows[0];
    if (!row) return { outcome: 'none', reason: 'profile' };
    // Агент — то же правило, что у кабинета агента (requireApprovedAgent):
    // до одобрения администратором кабинета нет, значит и клиентов в нём.
    if (category === 'agent' && row.profile_status !== 'approved') {
      return { outcome: 'none', reason: 'not_approved' };
    }
    return { outcome: 'ok', partnerId: row.id, category, userId };
  } catch (err) {
    const code = (err as { code?: string })?.code ?? 'нет SQLSTATE';
    console.error('[crm] partnerContextFor: профиль партнёра не прочитан, SQLSTATE', code);
    return { outcome: 'unavailable', reason: `sqlstate ${code}` };
  }
}

const NONE_MESSAGES: Record<'role' | 'profile' | 'not_approved', string> = {
  role: 'Раздел доступен партнёрам платформы',
  profile: 'Профиль партнёра не найден — заполните его в кабинете',
  not_approved: AGENT_NOT_APPROVED_MESSAGE,
};

/**
 * Гард роутов CRM: вход, партнёрская роль, профиль. Возвращает контекст либо
 * готовый ответ: 401/403 от requireRole, 403 — профиля нет, 503 — не смогли
 * проверить.
 */
export async function requirePartner(req: NextRequest): Promise<PartnerContextOk | NextResponse> {
  const auth = await requireRole(req, [...PARTNER_ROLES]);
  if (auth instanceof NextResponse) return auth;
  const ctx = await partnerContextFor(auth.userId, auth.role);
  if (ctx.outcome === 'ok') return ctx;
  if (ctx.outcome === 'unavailable') {
    return NextResponse.json(
      { success: false, error: 'Не удалось проверить профиль партнёра, попробуйте позже' },
      { status: 503 },
    );
  }
  return NextResponse.json({ success: false, error: NONE_MESSAGES[ctx.reason] }, { status: 403 });
}
