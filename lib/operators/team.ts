/**
 * Команда оператора: приглашение менеджера по ссылке, принятие, права,
 * снятие (CRM фаза 2г, миграция 1223).
 *
 * Пишет только владелец кабинета (роуты /api/hub/operator/team идут через
 * requireOperatorOwner); принимает ссылку тот, кто её открыл и вошёл своим
 * аккаунтом (/api/team/join/[token]).
 *
 * Правила принятия:
 *   - ссылка жива: статус invited и срок не истёк;
 *   - у человека нет своего кабинета оператора — иначе резолвер открывал бы
 *     ему свой, а не командный (lib/operators/team-access.ts);
 *   - человек не менеджер другого оператора (одна команда разом);
 *   - после принятия хеш токена стирается: ссылка одноразовая.
 */
import type { PoolClient } from 'pg';
import { pool } from '@/lib/db-pool';
import { ownedRoles } from '@/lib/auth/role-switch';
import {
  INVITE_TTL_DAYS, MAX_PENDING_INVITES, generateInviteToken, hashInviteToken, isInviteTokenShape,
} from '@/lib/operators/team-invite';
import type { ManagerPerms } from '@/lib/operators/team-access';

export type MemberStatus = 'invited' | 'active' | 'revoked';

export interface TeamMember {
  id: string;
  status: MemberStatus;
  label: string | null;
  /** Кто принял ссылку: имя и почта аккаунта. До принятия — null. */
  user_name: string | null;
  user_email: string | null;
  can_edit_prices: boolean;
  can_cancel_bookings: boolean;
  created_at: string;
  invite_expires_at: string | null;
  accepted_at: string | null;
  revoked_at: string | null;
  /** Ссылка ждёт, но срок вышел. */
  expired: boolean;
}

interface Queryable {
  query: typeof pool.query;
}

const MEMBER_COLUMNS = `
  m.id::text AS id, m.status, m.label,
  u.name AS user_name, u.email AS user_email,
  m.can_edit_prices, m.can_cancel_bookings,
  m.created_at::text AS created_at, m.invite_expires_at::text AS invite_expires_at,
  m.accepted_at::text AS accepted_at, m.revoked_at::text AS revoked_at,
  (m.status = 'invited' AND m.invite_expires_at <= NOW()) AS expired`;

/** Команда кабинета: действующие и ждущие сверху, снятые — последние 20. */
export async function listTeam(partnerId: string, db: Queryable = pool): Promise<TeamMember[]> {
  const { rows } = await db.query<TeamMember>(
    `(SELECT ${MEMBER_COLUMNS}
        FROM operator_members m LEFT JOIN users u ON u.id = m.user_id
       WHERE m.partner_id = $1::uuid AND m.status IN ('active', 'invited')
       ORDER BY m.status, m.created_at DESC)
     UNION ALL
     (SELECT ${MEMBER_COLUMNS}
        FROM operator_members m LEFT JOIN users u ON u.id = m.user_id
       WHERE m.partner_id = $1::uuid AND m.status = 'revoked'
       ORDER BY m.revoked_at DESC NULLS LAST
       LIMIT 20)`,
    [partnerId],
  );
  return rows;
}

export interface NewInvite {
  partnerId: string;
  invitedBy: string;
  label: string | null;
  perms: ManagerPerms;
}

export type CreateInviteResult =
  | { outcome: 'ok'; member: TeamMember; token: string }
  | { outcome: 'too_many' };

export async function createInvite(p: NewInvite, db: Queryable = pool): Promise<CreateInviteResult> {
  const { rows: pending } = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM operator_members
      WHERE partner_id = $1::uuid AND status = 'invited' AND invite_expires_at > NOW()`,
    [p.partnerId],
  );
  if ((pending[0]?.n ?? 0) >= MAX_PENDING_INVITES) return { outcome: 'too_many' };

  const token = generateInviteToken();
  const { rows } = await db.query<TeamMember>(
    `WITH ins AS (
       INSERT INTO operator_members
         (partner_id, status, label, invite_token_hash, invite_expires_at, invited_by,
          can_edit_prices, can_cancel_bookings)
       VALUES ($1::uuid, 'invited', $2, $3, NOW() + make_interval(days => $4::int), $5::uuid, $6, $7)
       RETURNING *
     )
     SELECT ${MEMBER_COLUMNS} FROM ins m LEFT JOIN users u ON u.id = m.user_id`,
    [p.partnerId, p.label, hashInviteToken(token), INVITE_TTL_DAYS, p.invitedBy,
      p.perms.can_edit_prices, p.perms.can_cancel_bookings],
  );
  return { outcome: 'ok', member: rows[0], token };
}

export interface MemberPatch {
  label?: string | null;
  can_edit_prices?: boolean;
  can_cancel_bookings?: boolean;
}

/** Права и подпись менеджера этого кабинета. null — нет такого или он снят. */
export async function updateMember(
  partnerId: string, memberId: string, patch: MemberPatch, db: Queryable = pool,
): Promise<TeamMember | null> {
  const { rows } = await db.query<TeamMember>(
    `WITH upd AS (
       UPDATE operator_members
          SET label = CASE WHEN $3::boolean THEN $4 ELSE label END,
              can_edit_prices = COALESCE($5::boolean, can_edit_prices),
              can_cancel_bookings = COALESCE($6::boolean, can_cancel_bookings),
              updated_at = NOW()
        WHERE id = $2::uuid AND partner_id = $1::uuid AND status IN ('invited', 'active')
        RETURNING *
     )
     SELECT ${MEMBER_COLUMNS} FROM upd m LEFT JOIN users u ON u.id = m.user_id`,
    [partnerId, memberId, patch.label !== undefined, patch.label ?? null,
      patch.can_edit_prices ?? null, patch.can_cancel_bookings ?? null],
  );
  return rows[0] ?? null;
}

/**
 * Снять менеджера или отозвать ждущую ссылку. Доступ закрывается сразу:
 * резолвер кабинета спрашивает базу на каждом запросе. Снятому убирается
 * роль operator из его ролей, если своего кабинета оператора у него нет, —
 * иначе при следующем входе он попадал бы в пустой кабинет.
 */
export async function revokeMember(partnerId: string, memberId: string, revokedBy: string): Promise<TeamMember | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string; user_id: string | null }>(
      `UPDATE operator_members
          SET status = 'revoked', revoked_at = NOW(), revoked_by = $3::uuid,
              invite_token_hash = NULL, updated_at = NOW()
        WHERE id = $2::uuid AND partner_id = $1::uuid AND status IN ('invited', 'active')
        RETURNING id::text AS id, user_id::text AS user_id`,
      [partnerId, memberId, revokedBy],
    );
    const row = rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return null;
    }
    if (row.user_id) await dropOperatorRole(client, row.user_id);
    const { rows: out } = await client.query<TeamMember>(
      `SELECT ${MEMBER_COLUMNS} FROM operator_members m LEFT JOIN users u ON u.id = m.user_id WHERE m.id = $1::uuid`,
      [row.id],
    );
    await client.query('COMMIT');
    return out[0] ?? null;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function dropOperatorRole(client: PoolClient, userId: string): Promise<void> {
  await client.query(
    `UPDATE users
        SET preferences = jsonb_set(COALESCE(preferences, '{}'::jsonb), '{roles}',
                                    COALESCE(preferences->'roles', '[]'::jsonb) - 'operator'),
            role = CASE WHEN role = 'operator' THEN 'tourist' ELSE role END,
            updated_at = NOW()
      WHERE id = $1::uuid
        AND NOT EXISTS (SELECT 1 FROM partners p WHERE p.user_id = $1::uuid AND p.category = 'operator')
        AND NOT EXISTS (SELECT 1 FROM operator_members m WHERE m.user_id = $1::uuid AND m.status = 'active')`,
    [userId],
  );
}

export type InvitePreview =
  | { state: 'ok'; operator_name: string; label: string | null; expires_at: string; perms: ManagerPerms }
  | { state: 'invalid' }
  | { state: 'expired' };

interface InviteRow {
  id: string;
  partner_id: string;
  status: MemberStatus;
  expired: boolean;
  owner_user_id: string | null;
  operator_name: string | null;
  label: string | null;
  invite_expires_at: string;
  can_edit_prices: boolean;
  can_cancel_bookings: boolean;
}

const INVITE_BY_HASH = `
  SELECT m.id::text AS id, m.partner_id::text AS partner_id, m.status,
         (m.invite_expires_at <= NOW()) AS expired,
         p.user_id::text AS owner_user_id, p.name AS operator_name, m.label,
         m.invite_expires_at::text AS invite_expires_at,
         m.can_edit_prices, m.can_cancel_bookings
    FROM operator_members m
    JOIN partners p ON p.id = m.partner_id AND p.category = 'operator'
   WHERE m.invite_token_hash = $1`;

/** Что за приглашение — для страницы принятия. Использованная ссылка неотличима от выдуманной. */
export async function previewInvite(token: string, db: Queryable = pool): Promise<InvitePreview> {
  if (!isInviteTokenShape(token)) return { state: 'invalid' };
  const { rows } = await db.query<InviteRow>(INVITE_BY_HASH, [hashInviteToken(token)]);
  const row = rows[0];
  if (!row || row.status !== 'invited') return { state: 'invalid' };
  if (row.expired) return { state: 'expired' };
  return {
    state: 'ok',
    operator_name: row.operator_name ?? 'Оператор',
    label: row.label,
    expires_at: row.invite_expires_at,
    perms: { can_edit_prices: row.can_edit_prices, can_cancel_bookings: row.can_cancel_bookings },
  };
}

export type AcceptResult =
  | { outcome: 'ok'; partnerId: string; operatorName: string }
  | { outcome: 'invalid' }
  | { outcome: 'expired' }
  /** Своя ссылка или у человека свой кабинет оператора. */
  | { outcome: 'own_cabinet' }
  /** Уже менеджер — этого или другого оператора. */
  | { outcome: 'already_member' };

export async function acceptInvite(token: string, userId: string): Promise<AcceptResult> {
  if (!isInviteTokenShape(token)) return { outcome: 'invalid' };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<InviteRow>(`${INVITE_BY_HASH} FOR UPDATE OF m`, [hashInviteToken(token)]);
    const inv = rows[0];
    const early = (r: AcceptResult) => client.query('ROLLBACK').then(() => r);
    if (!inv || inv.status !== 'invited') return await early({ outcome: 'invalid' });
    if (inv.expired) return await early({ outcome: 'expired' });
    if (inv.owner_user_id === userId) return await early({ outcome: 'own_cabinet' });

    const { rows: own } = await client.query(
      `SELECT 1 FROM partners WHERE user_id = $1::uuid AND category = 'operator' LIMIT 1`, [userId],
    );
    if (own.length > 0) return await early({ outcome: 'own_cabinet' });
    const { rows: active } = await client.query(
      `SELECT 1 FROM operator_members WHERE user_id = $1::uuid AND status = 'active' LIMIT 1`, [userId],
    );
    if (active.length > 0) return await early({ outcome: 'already_member' });

    await client.query(
      `UPDATE operator_members
          SET status = 'active', user_id = $2::uuid, accepted_at = NOW(),
              invite_token_hash = NULL, updated_at = NOW()
        WHERE id = $1::uuid`,
      [inv.id, userId],
    );

    // Роль operator — в собственные роли: дальше человек переключается в
    // кабинет обычным /api/auth/switch-role, профиль ему там не заводится
    // (ensurePartnerForRole видит действующее членство).
    const { rows: users } = await client.query<{ role: string | null; preferences: { roles?: unknown } | null }>(
      `SELECT role, preferences FROM users WHERE id = $1::uuid FOR UPDATE`, [userId],
    );
    const u = users[0];
    if (!u) return await early({ outcome: 'invalid' });
    const roles = [...new Set([...ownedRoles(u.preferences?.roles, u.role), 'operator'])];
    await client.query(
      `UPDATE users
          SET preferences = jsonb_set(COALESCE(preferences, '{}'::jsonb), '{roles}', $2::jsonb),
              updated_at = NOW()
        WHERE id = $1::uuid`,
      [userId, JSON.stringify(roles)],
    );
    await client.query('COMMIT');
    return { outcome: 'ok', partnerId: inv.partner_id, operatorName: inv.operator_name ?? 'Оператор' };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // Два принятия разом наткнулись на «одна команда на человека».
    if ((err as { code?: string } | null)?.code === '23505') return { outcome: 'already_member' };
    throw err;
  } finally {
    client.release();
  }
}
