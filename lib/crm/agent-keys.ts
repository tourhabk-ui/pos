/**
 * lib/crm/agent-keys.ts — ключи MCP партнёра к своей CRM (CRM #2325, шаг 1д-2).
 *
 * Партнёр выпускает ключ в кабинете и отдаёт его своему ИИ-агенту; агент
 * ходит на /api/mcp/partner с `Authorization: Bearer vdr_pk_…` и видит те же
 * инструменты CRM, что Кузьмич в чате партнёра (`lib/crm/tools.ts`).
 *
 * Условия владельца (карт-бланш на 1д):
 *  - ключ хранится хешем (sha256) и показывается один раз — при выпуске;
 *    в базе, в списке кабинета и в логах его нет;
 *  - ключ отзывается в кабинете, и отозванный не пускает со следующего
 *    запроса (проверка — по `revoked_at IS NULL` на каждом запросе);
 *  - по умолчанию ключ только для чтения; право записи включает партнёр.
 *
 * Поиск по хешу через уникальный индекс: сравнения секрета в коде нет, и
 * времени на нём не измерить. Ключ неправильной формы до базы не доходит.
 */
import { createHash, randomBytes } from 'node:crypto';
import { pool } from '@/lib/db-pool';
import { crmCategoryFor, type PartnerCategory } from '@/lib/crm/partner-context';
import type { PartnerApiKeyRow } from '@/lib/types/db-rows';
import type { AgentKeyItem } from '@/lib/crm/agent-key-item';

export type { AgentKeyItem };

interface Queryable {
  query: typeof pool.query;
}

export const AGENT_KEY_PREFIX = 'vdr_pk_';
const KEY_BYTES = 32;
/** base64url от 32 байт — 43 знака без выравнивания. */
const KEY_BODY = /^[A-Za-z0-9_-]{43}$/;
/** Сколько знаков ключа видно в списке кабинета: префикс и шесть знаков. */
const SHOWN_CHARS = AGENT_KEY_PREFIX.length + 6;
/** Действующих ключей у партнёра не больше: по одному на агента, а не на каждый опыт. */
export const MAX_ACTIVE_KEYS = 5;

export function generateAgentKey(randomSource: (n: number) => Buffer = randomBytes): string {
  return `${AGENT_KEY_PREFIX}${randomSource(KEY_BYTES).toString('base64url')}`;
}

export function hashAgentKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function isAgentKeyShape(key: string): boolean {
  return key.startsWith(AGENT_KEY_PREFIX) && KEY_BODY.test(key.slice(AGENT_KEY_PREFIX.length));
}

/** Ключ из заголовка Authorization: только схема Bearer, иначе null. */
export function bearerKey(header: string | null): string | null {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  return m ? m[1] : null;
}

function iso(v: Date | string | null): string | null {
  if (v === null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}


type KeyListRow = Pick<PartnerApiKeyRow, 'id' | 'label' | 'key_prefix' | 'can_write' | 'created_at' | 'last_used_at' | 'revoked_at'>;

function toItem(r: KeyListRow): AgentKeyItem {
  return {
    id: r.id,
    label: r.label,
    key_prefix: r.key_prefix,
    can_write: r.can_write,
    created_at: iso(r.created_at) ?? '',
    last_used_at: iso(r.last_used_at),
    revoked_at: iso(r.revoked_at),
  };
}

const LIST_COLUMNS = 'id, label, key_prefix, can_write, created_at, last_used_at, revoked_at';

/** Ключи партнёра: действующие сверху, отозванные — последние двадцать. */
export async function listAgentKeys(partnerId: string, db: Queryable = pool): Promise<AgentKeyItem[]> {
  const { rows } = await db.query<KeyListRow>(
    `(SELECT ${LIST_COLUMNS} FROM partner_api_keys WHERE partner_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC)
     UNION ALL
     (SELECT ${LIST_COLUMNS} FROM partner_api_keys WHERE partner_id = $1 AND revoked_at IS NOT NULL ORDER BY revoked_at DESC LIMIT 20)`,
    [partnerId],
  );
  return rows.map(toItem);
}

export type CreateKeyResult =
  | { outcome: 'created'; key: string; item: AgentKeyItem }
  | { outcome: 'limit' };

/**
 * Выпустить ключ. Сам ключ возвращается только здесь — партнёр видит его
 * один раз; в базу уходит хеш. Предел действующих ключей проверяется в том
 * же запросе, что и вставка.
 */
export async function createAgentKey(
  partnerId: string,
  input: { label: string; canWrite: boolean; createdBy: string | null },
  db: Queryable = pool,
  randomSource?: (n: number) => Buffer,
): Promise<CreateKeyResult> {
  const label = input.label.replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!label) throw new Error('ключ без названия');
  const key = generateAgentKey(randomSource);
  const { rows } = await db.query<KeyListRow>(
    `INSERT INTO partner_api_keys (partner_id, label, key_prefix, key_hash, can_write, created_by)
     SELECT $1::uuid, $2::text, $3::text, $4::text, $5::boolean, $6::uuid
      WHERE (SELECT count(*) FROM partner_api_keys WHERE partner_id = $1::uuid AND revoked_at IS NULL) < $7::int
     RETURNING ${LIST_COLUMNS}`,
    [partnerId, label, key.slice(0, SHOWN_CHARS), hashAgentKey(key), input.canWrite, input.createdBy, MAX_ACTIVE_KEYS],
  );
  if (!rows[0]) return { outcome: 'limit' };
  return { outcome: 'created', key, item: toItem(rows[0]) };
}

/** Отозвать ключ партнёра. Чужой и уже отозванный — false. */
export async function revokeAgentKey(
  partnerId: string,
  keyId: string,
  revokedBy: string | null,
  db: Queryable = pool,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE partner_api_keys SET revoked_at = NOW(), revoked_by = $3
      WHERE id = $2::uuid AND partner_id = $1 AND revoked_at IS NULL`,
    [partnerId, keyId, revokedBy],
  );
  return (rowCount ?? 0) > 0;
}

export interface AgentKeyContext {
  keyId: string;
  partnerId: string;
  partnerName: string;
  category: PartnerCategory;
  userId: string | null;
  canWrite: boolean;
}

/**
 * Чей ключ. Три исхода и отказ (§4.0): ключ действует / ключа нет или он
 * отозван / CRM этой записи не положена (агент без одобрения) / база не
 * ответила. Последний не равен «ключа нет»: роут отвечает 503, а не 401.
 */
export type AgentKeyLookup =
  | { outcome: 'ok'; key: AgentKeyContext }
  | { outcome: 'invalid' }
  | { outcome: 'no_crm' }
  | { outcome: 'unavailable' };

export async function resolveAgentKey(rawKey: string | null, db: Queryable = pool): Promise<AgentKeyLookup> {
  if (!rawKey || !isAgentKeyShape(rawKey)) return { outcome: 'invalid' };
  try {
    const { rows } = await db.query<{
      id: string; partner_id: string; can_write: boolean; name: string; category: string;
      user_id: string | null; profile_status: string | null;
    }>(
      `SELECT k.id, k.partner_id::text AS partner_id, k.can_write,
              COALESCE(p.company_name, p.name) AS name, p.category,
              p.user_id::text AS user_id, p.profile_status
         FROM partner_api_keys k
         JOIN partners p ON p.id = k.partner_id
        WHERE k.key_hash = $1 AND k.revoked_at IS NULL`,
      [hashAgentKey(rawKey)],
    );
    const row = rows[0];
    if (!row) return { outcome: 'invalid' };
    const category = crmCategoryFor(row.category, row.profile_status);
    if (!category) return { outcome: 'no_crm' };
    return {
      outcome: 'ok',
      key: { keyId: row.id, partnerId: row.partner_id, partnerName: row.name, category, userId: row.user_id, canWrite: row.can_write },
    };
  } catch (err) {
    const code = (err as { code?: string })?.code ?? 'нет SQLSTATE';
    console.error('[crm-agent-keys] ключ не проверен, SQLSTATE', code);
    return { outcome: 'unavailable' };
  }
}

/**
 * Отметка «агент заходил». Не чаще раза в минуту на ключ: каждый вызов
 * писать в базу незачем, кабинету нужна свежесть до минуты. Отказ не ломает
 * ответ агенту, но называется в логе.
 */
export async function touchAgentKey(keyId: string, db: Queryable = pool): Promise<void> {
  try {
    await db.query(
      `UPDATE partner_api_keys SET last_used_at = NOW()
        WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < NOW() - INTERVAL '1 minute')`,
      [keyId],
    );
  } catch (err) {
    const code = (err as { code?: string })?.code ?? 'нет SQLSTATE';
    console.error('[crm-agent-keys] отметка использования не записана, SQLSTATE', code);
  }
}
