/**
 * Согласие партнёра на использование материалов его сайта — запись и чтение
 * (миграция 1321, решение владельца 23.10).
 *
 * Три исхода у каждого чтения (§4.0): согласие есть / записи нет / не смогли
 * прочитать (исключение — вызывающий говорит «сбой», а не «согласия нет»).
 * «Отозвано» — отдельное состояние, строка не удаляется.
 */
import { createHash, randomBytes } from 'crypto';
import { query, transaction } from '@/lib/database';
import {
  PARTNER_MATERIALS_CONSENT_VERSION, consentDocument, type MaterialsConsentPublic,
} from '@/lib/legal/partner-materials-consent';

export type { MaterialsConsentPublic };
import type { PdConsentRecord } from '@/lib/legal/pd-consent';
import {
  PARTNER_CONSENT_INVITE_DAYS, consentInviteVerdict, type GrantProblem, type InviteProblem,
} from '@/lib/partners/material-consent-rules';

export function hashConsentKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export interface MaterialsConsentAdmin extends MaterialsConsentPublic {
  id: string;
  textVersion: string;
  signedText: string;
  signerName: string;
  signerRole: string;
  revokedAt: string | null;
  /** YYYY-MM-DD по Камчатке; null — не отозвано. */
  revokedOn: string | null;
  revokeReason: string | null;
}

interface ConsentRow {
  id: string;
  text_version: string;
  signed_text: string;
  sites: string[];
  signer_name: string;
  signer_role: string;
  granted_on: string;
  revoked_at: string | null;
  revoked_on: string | null;
  revoke_reason: string | null;
}

const CONSENT_COLUMNS = `c.id::text AS id, c.text_version, c.signed_text, c.sites, c.signer_name, c.signer_role,
  to_char(c.granted_at AT TIME ZONE 'Asia/Kamchatka', 'YYYY-MM-DD') AS granted_on,
  c.revoked_at::text AS revoked_at,
  to_char(c.revoked_at AT TIME ZONE 'Asia/Kamchatka', 'YYYY-MM-DD') AS revoked_on, c.revoke_reason`;

function toAdmin(r: ConsentRow): MaterialsConsentAdmin {
  return {
    id: r.id,
    textVersion: r.text_version,
    signedText: r.signed_text,
    sites: r.sites ?? [],
    signerName: r.signer_name,
    signerRole: r.signer_role,
    grantedOn: r.granted_on,
    revokedAt: r.revoked_at,
    revokedOn: r.revoked_on,
    revokeReason: r.revoke_reason,
  };
}

/**
 * SQL-выражение действующего согласия партнёра для витрины: последнее
 * неотозванное, без имени подписанта. Встраивается в загрузчики страниц
 * перевозчика и прокатчика (LEFT JOIN LATERAL), чтобы не делать второй запрос.
 */
export const ACTIVE_CONSENT_JSON_SQL = (alias: string) => `(
  SELECT jsonb_build_object(
           'grantedOn', to_char(c.granted_at AT TIME ZONE 'Asia/Kamchatka', 'YYYY-MM-DD'),
           'sites', to_jsonb(c.sites))
    FROM partner_material_consents c
   WHERE c.partner_id = ${alias}.id AND c.revoked_at IS NULL
   ORDER BY c.granted_at DESC
   LIMIT 1)`;

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** Разбор JSON из ACTIVE_CONSENT_JSON_SQL; мусор — null («записи нет»), не выдумка. */
export function parseActiveConsent(v: unknown): MaterialsConsentPublic | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.grantedOn !== 'string' || !isStringArray(o.sites)) return null;
  return { grantedOn: o.grantedOn, sites: o.sites };
}

/** История согласий партнёра для админки, новые сверху. */
export async function loadPartnerConsents(partnerId: string): Promise<MaterialsConsentAdmin[]> {
  const { rows } = await query<ConsentRow>(
    `SELECT ${CONSENT_COLUMNS}
       FROM partner_material_consents c
      WHERE c.partner_id = $1
      ORDER BY c.granted_at DESC
      LIMIT 10`,
    [partnerId],
  );
  return rows.map(toAdmin);
}

/**
 * Ссылка партнёра для админки: даты по Камчатке и состояние, посчитанное на
 * сервере тем же правилом, что проверяет ключ (`consentInviteVerdict`), — без
 * разбора дат в браузере и без «действует до» у просроченной (ревью 23.10).
 */
export interface InviteState {
  issuedOn: string;
  expiresOn: string;
  state: 'pending' | 'expired' | 'used';
}

export async function loadConsentInvite(partnerId: string, now: number = Date.now()): Promise<InviteState | null> {
  const { rows } = await query<{ issued_on: string; expires_on: string; expires_at: string; used_at: string | null }>(
    `SELECT to_char(issued_at AT TIME ZONE 'Asia/Kamchatka', 'YYYY-MM-DD') AS issued_on,
            to_char(expires_at AT TIME ZONE 'Asia/Kamchatka', 'YYYY-MM-DD') AS expires_on,
            expires_at::text AS expires_at, used_at::text AS used_at
       FROM partner_consent_invites WHERE partner_id = $1`,
    [partnerId],
  );
  const r = rows[0];
  if (!r) return null;
  const v = consentInviteVerdict({ expiresAt: r.expires_at, usedAt: r.used_at }, now);
  return { issuedOn: r.issued_on, expiresOn: r.expires_on, state: v.ok ? 'pending' : v.reason === 'used' ? 'used' : 'expired' };
}

/** Сайты партнёра из трёх мест хранения (как lib/partners/site-watch-run), без повторов. */
const PARTNER_SQL = `
  SELECT p.id::text AS id, p.name,
         ARRAY_REMOVE(ARRAY[
           NULLIF(btrim(p.website), ''),
           CASE WHEN jsonb_typeof(p.contacts) = 'object' THEN NULLIF(btrim(p.contacts->>'website'), '') END,
           CASE WHEN jsonb_typeof(p.contact) = 'object' THEN NULLIF(btrim(p.contact->>'website'), '') END
         ], NULL) AS sites
    FROM partners p
   WHERE p.id = $1`;

interface PartnerRow { id: string; name: string; sites: string[] }

function uniqueSites(sites: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of sites) {
    const k = s.trim().replace(/\/+$/, '').toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(s.trim());
  }
  return out;
}

export type IssueConsentInviteResult =
  | { ok: true; key: string; expiresAt: string; partnerName: string }
  | { ok: false; reason: 'not_found' };

/** Новая ссылка на согласие: прежняя (и использованная тоже) гаснет. */
export async function issueConsentInvite(partnerId: string, now: number = Date.now()): Promise<IssueConsentInviteResult> {
  const partner = await query<PartnerRow>(PARTNER_SQL, [partnerId]);
  const p = partner.rows[0];
  if (!p) return { ok: false, reason: 'not_found' };
  const key = randomBytes(24).toString('base64url');
  const expiresAt = new Date(now + PARTNER_CONSENT_INVITE_DAYS * 86_400_000).toISOString();
  await query(
    `INSERT INTO partner_consent_invites (partner_id, key_hash, issued_at, expires_at, used_at)
     VALUES ($1, $2, NOW(), $3::timestamptz, NULL)
     ON CONFLICT (partner_id) DO UPDATE
       SET key_hash = EXCLUDED.key_hash, issued_at = NOW(), expires_at = EXCLUDED.expires_at, used_at = NULL`,
    [p.id, hashConsentKey(key), expiresAt],
  );
  return { ok: true, key, expiresAt, partnerName: p.name };
}

const INVITE_SQL = `
  SELECT i.partner_id::text AS partner_id, i.expires_at::text AS expires_at, i.used_at::text AS used_at
    FROM partner_consent_invites i
   WHERE i.key_hash = $1`;

interface InviteRow { partner_id: string; expires_at: string; used_at: string | null }

export type ConsentInviteCheck =
  | { state: 'ok'; partnerName: string; sites: string[]; current: MaterialsConsentPublic | null }
  | { state: InviteProblem };

/** Кто партнёр по ключу ссылки и есть ли действующее согласие — без имени прежнего подписанта. */
export async function checkConsentInvite(key: string, now: number = Date.now()): Promise<ConsentInviteCheck> {
  const { rows } = await query<InviteRow>(INVITE_SQL, [hashConsentKey(key)]);
  const row = rows[0];
  if (!row) return { state: 'unknown' };
  const v = consentInviteVerdict({ expiresAt: row.expires_at, usedAt: row.used_at }, now);
  if (!v.ok) return { state: v.reason };
  const partner = await query<PartnerRow & { active: unknown }>(
    `SELECT q.*, ${ACTIVE_CONSENT_JSON_SQL('p')} AS active FROM (${PARTNER_SQL}) q JOIN partners p ON p.id::text = q.id`,
    [row.partner_id],
  );
  const p = partner.rows[0];
  if (!p) return { state: 'unknown' };
  return { state: 'ok', partnerName: p.name, sites: uniqueSites(p.sites ?? []), current: parseActiveConsent(p.active) };
}

export type GrantConsentResult =
  | { ok: true; grantedOn: string; partnerName: string }
  | { ok: false; reason: GrantProblem };

/** Причина, с которой гаснет прежнее согласие, когда партнёр подписал новое. */
export const SUPERSEDED_REASON = 'Заменено новым согласием партнёра';

/**
 * Записать согласие по ключу. Транзакция: ссылка проверяется под FOR UPDATE и
 * гасится той же транзакцией, что пишет согласие (две вкладки не запишут два).
 * Текст собирает сервер из имени и сайтов партнёра и сверяет с тем, что
 * показала страница (`shownText`): разошлись — 'text_changed', записи нет.
 * Пишется собранный сервером текст, присланный — только сверяется.
 * Прежнее действующее согласие не удаляется, а гаснет с причиной «заменено
 * новым»: иначе после отзыва нового старое снова считалось бы действующим.
 */
export async function grantMaterialsConsent(p: {
  key: string;
  signerName: string;
  signerRole: string;
  shownText: string;
  pd: PdConsentRecord;
  now?: number;
}): Promise<GrantConsentResult> {
  return transaction<GrantConsentResult>(async (client) => {
    const { rows } = await client.query<InviteRow>(`${INVITE_SQL} FOR UPDATE OF i`, [hashConsentKey(p.key)]);
    const row = rows[0];
    if (!row) return { ok: false, reason: 'unknown' } as const;
    const v = consentInviteVerdict({ expiresAt: row.expires_at, usedAt: row.used_at }, p.now ?? Date.now());
    if (!v.ok) return { ok: false, reason: v.reason } as const;

    const partner = await client.query<PartnerRow>(PARTNER_SQL, [row.partner_id]);
    const pr = partner.rows[0];
    if (!pr) return { ok: false, reason: 'unknown' } as const;
    const sites = uniqueSites(pr.sites ?? []);
    const signedText = consentDocument({ partnerName: pr.name, sites });
    if (p.shownText !== signedText) return { ok: false, reason: 'text_changed' } as const;

    await client.query(
      `UPDATE partner_material_consents SET revoked_at = NOW(), revoke_reason = $2
        WHERE partner_id = $1::uuid AND revoked_at IS NULL`,
      [row.partner_id, SUPERSEDED_REASON],
    );
    const ins = await client.query<{ granted_on: string }>(
      `INSERT INTO partner_material_consents
         (partner_id, text_version, signed_text, sites, signer_name, signer_role, source,
          pd_consent_at, pd_consent_ip, pd_consent_source, pd_consent_version)
       VALUES ($1::uuid, $2, $3, $4::text[], $5, $6, 'link', $7, $8, $9, $10)
       RETURNING to_char(granted_at AT TIME ZONE 'Asia/Kamchatka', 'YYYY-MM-DD') AS granted_on`,
      [
        row.partner_id, PARTNER_MATERIALS_CONSENT_VERSION, signedText, sites,
        p.signerName, p.signerRole, p.pd.at, p.pd.ip, p.pd.source, p.pd.version,
      ],
    );
    await client.query(`UPDATE partner_consent_invites SET used_at = NOW() WHERE partner_id = $1::uuid`, [row.partner_id]);
    return { ok: true, grantedOn: ins.rows[0]!.granted_on, partnerName: pr.name } as const;
  });
}

export type RevokeResult = { ok: true; revoked: number } | { ok: false; reason: 'nothing_active' };

/** Отзыв со слов партнёра: все действующие согласия получают дату и причину. */
export async function revokeMaterialsConsent(partnerId: string, reason: string): Promise<RevokeResult> {
  const { rows } = await query<{ id: string }>(
    `UPDATE partner_material_consents
        SET revoked_at = NOW(), revoke_reason = $2
      WHERE partner_id = $1::uuid AND revoked_at IS NULL
      RETURNING id::text`,
    [partnerId, reason],
  );
  return rows.length > 0 ? { ok: true, revoked: rows.length } : { ok: false, reason: 'nothing_active' };
}
