/**
 * Кто вошёл в кабинет оператора: владелец или менеджер его команды
 * (CRM фаза 2г, миграция 1223).
 *
 * Решение владельца 11.10: менеджеру доступно всё, кроме денег и настроек;
 * цены и отмену броней открывает владелец кабинета отдельными правами.
 *
 * Роли manager в JWT нет: lib/auth.ts и middleware.ts не трогаются (§7).
 * Менеджер входит с ролью operator, а владелец он или менеджер, решает
 * таблица operator_members. Права проверяются по базе на каждом запросе:
 * владелец снял менеджера — доступ закрыт сразу, без перевыпуска токена.
 *
 * Четыре исхода (§4.0): владелец / менеджер / не оператор (с причиной) /
 * «не смогли проверить». Последнее — не «доступа нет»: роут отвечает 503.
 * Здесь ничего не создаётся: «не оператор» — это ответ, а не повод заводить
 * строку в partners.
 *
 * Если владелец кабинета сам когда-то принял приглашение, побеждает свой
 * кабинет — но принять приглашение, имея свой кабинет, нельзя
 * (lib/operators/team.ts), так что это расхождение не возникает.
 */
import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { requireOperator } from '@/lib/auth/middleware';
import type { JWTPayload } from '@/lib/auth/jwt';

export type ManagerPermission = 'can_edit_prices' | 'can_cancel_bookings';

export interface ManagerPerms {
  can_edit_prices: boolean;
  can_cancel_bookings: boolean;
}

export type OperatorAccess =
  | { kind: 'owner'; partnerId: string }
  | { kind: 'manager'; partnerId: string; memberId: string; perms: ManagerPerms }
  | { kind: 'none'; reason: 'no_profile' | 'revoked' }
  | { kind: 'unavailable'; reason: string };

export type OperatorAccessOk = Extract<OperatorAccess, { kind: 'owner' | 'manager' }>;

export interface AccessRow {
  own_partner_id: string | null;
  member_partner_id: string | null;
  member_id: string | null;
  can_edit_prices: boolean | null;
  can_cancel_bookings: boolean | null;
  was_revoked: boolean | null;
}

/** Строка запроса → исход. Свой кабинет первым, затем команда. */
export function accessFromRow(row: AccessRow | undefined): OperatorAccess {
  if (row?.own_partner_id) return { kind: 'owner', partnerId: row.own_partner_id };
  if (row?.member_partner_id && row.member_id) {
    return {
      kind: 'manager',
      partnerId: row.member_partner_id,
      memberId: row.member_id,
      perms: {
        can_edit_prices: row.can_edit_prices === true,
        can_cancel_bookings: row.can_cancel_bookings === true,
      },
    };
  }
  return { kind: 'none', reason: row?.was_revoked ? 'revoked' : 'no_profile' };
}

// ORDER BY у своего кабинета: уникального индекса (user_id, category) нет, и
// при задвоенном профиле LIMIT 1 без порядка отдавал бы разные строки.
export const ACCESS_SQL = `
  WITH own AS (
    SELECT p.id::text AS partner_id
      FROM partners p
     WHERE p.user_id = $1::uuid AND p.category = 'operator'
     ORDER BY p.created_at ASC NULLS LAST, p.id ASC
     LIMIT 1
  ), mem AS (
    SELECT m.partner_id::text AS partner_id, m.id::text AS member_id,
           m.can_edit_prices, m.can_cancel_bookings
      FROM operator_members m
      JOIN partners p ON p.id = m.partner_id AND p.category = 'operator'
     WHERE m.user_id = $1::uuid AND m.status = 'active'
     LIMIT 1
  )
  SELECT (SELECT partner_id FROM own) AS own_partner_id,
         mem.partner_id AS member_partner_id, mem.member_id,
         mem.can_edit_prices, mem.can_cancel_bookings,
         EXISTS (SELECT 1 FROM operator_members r
                  WHERE r.user_id = $1::uuid AND r.status = 'revoked') AS was_revoked
    FROM (SELECT 1) AS one
    LEFT JOIN mem ON TRUE`;

// Запасной запрос на время, пока миграция 1223 не применена: только свой кабинет.
const OWNER_ONLY_SQL = `
  SELECT p.id::text AS own_partner_id, NULL::text AS member_partner_id, NULL::text AS member_id,
         NULL::boolean AS can_edit_prices, NULL::boolean AS can_cancel_bookings, FALSE AS was_revoked
    FROM partners p
   WHERE p.user_id = $1::uuid AND p.category = 'operator'
   ORDER BY p.created_at ASC NULLS LAST, p.id ASC
   LIMIT 1`;

interface Queryable {
  query: typeof pool.query;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function operatorAccess(userId: string, db: Queryable = pool): Promise<OperatorAccess> {
  if (!UUID_RE.test(userId)) return { kind: 'none', reason: 'no_profile' };
  try {
    const { rows } = await db.query<AccessRow>(ACCESS_SQL, [userId]);
    return accessFromRow(rows[0]);
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === '42P01') {
      // operator_members ещё нет — миграция не применена. Владельцы работают как
      // раньше, менеджеров ещё не бывает.
      try {
        const { rows } = await db.query<AccessRow>(OWNER_ONLY_SQL, [userId]);
        return accessFromRow(rows[0]);
      } catch (err2) {
        return unavailable(err2);
      }
    }
    return unavailable(err);
  }
}

function unavailable(err: unknown): OperatorAccess {
  const code = (err as { code?: string } | null)?.code ?? 'нет SQLSTATE';
  console.error('[operators/team-access] доступ к кабинету не проверен, SQLSTATE', code,
    err instanceof Error ? err.message : String(err));
  return { kind: 'unavailable', reason: `sqlstate ${code}` };
}

/** Может ли вошедший это действие: владельцу можно всё, менеджеру — по праву. */
export function managerMay(access: OperatorAccessOk, perm: ManagerPermission): boolean {
  return access.kind === 'owner' || access.perms[perm];
}

export const OWNER_ONLY_MESSAGE =
  'Этот раздел ведёт владелец кабинета: деньги и настройки менеджеру закрыты';

const PERMISSION_MESSAGES: Record<ManagerPermission, string> = {
  can_edit_prices: 'Цены меняет владелец кабинета или менеджер, которому он это разрешил',
  can_cancel_bookings: 'Отменить бронь может владелец кабинета или менеджер, которому он это разрешил',
};

export function permissionDenied(perm: ManagerPermission): NextResponse {
  return NextResponse.json({ success: false, error: PERMISSION_MESSAGES[perm] }, { status: 403 });
}

export function ownerOnlyDenied(): NextResponse {
  return NextResponse.json({ success: false, error: OWNER_ONLY_MESSAGE }, { status: 403 });
}

/** Ответ на исход «не владелец и не менеджер» / «не смогли проверить». */
export function accessFailure(access: Exclude<OperatorAccess, OperatorAccessOk>): NextResponse {
  if (access.kind === 'unavailable') {
    return NextResponse.json(
      { success: false, error: 'Не удалось проверить доступ к кабинету оператора — попробуйте позже' },
      { status: 503 },
    );
  }
  const error = access.reason === 'revoked'
    ? 'Владелец кабинета закрыл вам доступ'
    : 'Профиль оператора не найден';
  return NextResponse.json({ success: false, error }, { status: 403 });
}

/**
 * Право менеджера для роутов, которые находят кабинет через
 * getOperatorPartnerId: null — можно; иначе готовый ответ (403 без права,
 * 503 — не смогли проверить). Владельцу можно всё.
 */
export async function requireTeamPermission(userId: string, perm: ManagerPermission): Promise<NextResponse | null> {
  const access = await operatorAccess(userId);
  if (access.kind !== 'owner' && access.kind !== 'manager') return accessFailure(access);
  return managerMay(access, perm) ? null : permissionDenied(perm);
}

export type OperatorTeamContext = JWTPayload & { partnerId: string; access: OperatorAccessOk };

/** Гард кабинета: владелец или менеджер. */
export async function requireOperatorTeam(request: NextRequest): Promise<OperatorTeamContext | NextResponse> {
  const auth = await requireOperator(request);
  if (auth instanceof NextResponse) return auth;
  const access = await operatorAccess(auth.userId);
  if (access.kind !== 'owner' && access.kind !== 'manager') return accessFailure(access);
  return { ...auth, partnerId: access.partnerId, access };
}

/** Гард денег и настроек: только владелец кабинета. */
export async function requireOperatorOwner(request: NextRequest): Promise<OperatorTeamContext | NextResponse> {
  const ctx = await requireOperatorTeam(request);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.access.kind !== 'owner') return ownerOnlyDenied();
  return ctx;
}

/** Есть ли у человека действующее членство в команде (для тех, кто заводит профиль). */
export async function hasActiveMembership(userId: string, db: Queryable = pool): Promise<boolean> {
  if (!UUID_RE.test(userId)) return false;
  try {
    const { rows } = await db.query(
      `SELECT 1 FROM operator_members WHERE user_id = $1::uuid AND status = 'active' LIMIT 1`,
      [userId],
    );
    return rows.length > 0;
  } catch (err) {
    if ((err as { code?: string } | null)?.code === '42P01') return false;
    throw err;
  }
}
