/**
 * MCP handoff: безопасный токен между ответом агента и переходом на Ведар
 * (этап 2 плана метрик MCP; чертёж владельца 15.08 воспроизведён дословно
 * в части гарантий).
 *
 * Гарантии:
 *  - в БД только SHA-256 случайного 256-битного токена — утечка таблицы не
 *    открывает чужие ссылки;
 *  - target_path строится доверенным серверным кодом по белому списку —
 *    endpoint нельзя превратить в open redirect;
 *  - атрибуция — подписанная HttpOnly-cookie, клиентский JS её не читает и
 *    не подделывает; токен не живёт в query финальной страницы;
 *  - ни аргументов инструментов, ни имени, ни телефона, ни промпта здесь
 *    нет by construction.
 *
 * Без MCP_ATTRIBUTION_COOKIE_SECRET модуль деградирует мягко: ссылки и
 * редирект работают, атрибуция просто не пишется — MCP-ответ не должен
 * падать из-за незаданного env.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { pool } from '@/lib/db-pool';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';
const COOKIE_NAME = 'vedar_mcp_attr';
const HANDOFF_TTL_MS = 48 * 60 * 60 * 1000;        // ссылка: 48 часов
const ATTRIBUTION_TTL_SECONDS = 30 * 24 * 60 * 60; // cookie после перехода: 30 дней

export type McpTargetType = 'planner' | 'plan' | 'tour' | 'place' | 'safety';

export interface HandoffTarget {
  targetPath: string;
  targetType: McpTargetType;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function cookieSecret(): string | null {
  const secret = process.env.MCP_ATTRIBUTION_COOKIE_SECRET;
  return secret && secret.length >= 32 ? secret : null;
}

function signHandoffId(handoffId: string, secret: string): string {
  return createHmac('sha256', secret).update(handoffId, 'utf8').digest('base64url');
}

/**
 * Белый список путей — РЕАЛЬНЫЕ маршруты Ведара. Никогда не брать URL из
 * аргумента внешнего агента.
 */
export function isSafeTarget(target: HandoffTarget): boolean {
  const allowedPrefixes: Record<McpTargetType, string[]> = {
    planner: ['/planner'],
    plan: ['/plans/'],
    tour: ['/catalog/tours/'],
    place: ['/places/', '/routes/'],
    safety: ['/safety'],
  };

  return target.targetPath.startsWith('/') &&
    !target.targetPath.startsWith('//') &&
    allowedPrefixes[target.targetType].some((prefix) => target.targetPath.startsWith(prefix));
}

export async function issueMcpHandoff(input: {
  mcpSessionId?: string;
  mcpInvocationId?: string;
  toolName: string;
  target: HandoffTarget;
}): Promise<{ url: string; handoffId: string } | null> {
  if (!isSafeTarget(input.target)) return null;

  // 32 байта => 256 бит энтропии. Сохраняем хеш, а не token.
  const token = randomBytes(32).toString('base64url');
  const tokenHash = sha256(token);
  const expiresAt = new Date(Date.now() + HANDOFF_TTL_MS);

  try {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO mcp_handoffs
         (token_hash, mcp_session_id, mcp_invocation_id, tool_name, target_path, target_type, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        tokenHash,
        input.mcpSessionId ?? null,
        input.mcpInvocationId ?? null,
        input.toolName,
        input.target.targetPath,
        input.target.targetType,
        expiresAt,
      ],
    );
    const handoffId = result.rows[0]?.id;
    if (!handoffId) return null;

    await pool.query(
      `INSERT INTO mcp_handoff_events (handoff_id, event_type) VALUES ($1, 'issued')`,
      [handoffId],
    ).catch(() => {});

    return { handoffId, url: `${BASE_URL}/mcp/h/${token}` };
  } catch {
    // Телеметрия не важнее ответа агенту: не смогли выдать — ответ без ссылки.
    return null;
  }
}

export async function redeemMcpHandoff(rawToken: string): Promise<{
  handoffId: string;
  targetPath: string;
} | null> {
  try {
    // Атомарно: проверка TTL и отметка перехода одним UPDATE.
    const result = await pool.query<{ id: string; target_path: string }>(
      `UPDATE mcp_handoffs
          SET first_opened_at = COALESCE(first_opened_at, NOW()),
              last_opened_at = NOW(),
              open_count = open_count + 1
        WHERE token_hash = $1
          AND expires_at > NOW()
        RETURNING id, target_path`,
      [sha256(rawToken)],
    );
    const row = result.rows[0];
    if (!row) return null;

    await pool.query(
      `INSERT INTO mcp_handoff_events (handoff_id, event_type) VALUES ($1, 'opened')`,
      [row.id],
    ).catch(() => {});

    return { handoffId: row.id, targetPath: row.target_path };
  } catch {
    return null;
  }
}

/** null, если секрет не задан — редирект работает, атрибуция выключена. */
export function makeAttributionCookieValue(handoffId: string): string | null {
  const secret = cookieSecret();
  if (!secret) return null;
  return `${handoffId}.${signHandoffId(handoffId, secret)}`;
}

export function readVerifiedMcpAttribution(raw: string | undefined): string | null {
  const secret = cookieSecret();
  if (!raw || !secret) return null;
  const [handoffId, signature] = raw.split('.');
  if (!handoffId || !signature || !/^[0-9a-f-]{36}$/i.test(handoffId)) return null;

  const received = Buffer.from(signature);
  const wanted = Buffer.from(signHandoffId(handoffId, secret));
  if (received.length !== wanted.length || !timingSafeEqual(received, wanted)) return null;
  return handoffId;
}

/**
 * Записать действие после перехода. Зовут серверные ручки (лид, сохранение
 * плана и т.п.); клиенту передавать ничего не нужно. НИКОГДА не добавлять
 * сюда телефон, имя, комментарий или body формы.
 */
export async function attachMcpAttribution(
  cookieValue: string | undefined,
  // plan_shared вместо задуманного telegram_sent: отправка в Telegram уходит
  // с клиента (t.me-ссылка), сервер честно видит только создание share-ссылки.
  actionType: 'plan_saved' | 'plan_shared' | 'offline_bundle_downloaded' | 'lead_created',
): Promise<string | null> {
  const handoffId = readVerifiedMcpAttribution(cookieValue);
  if (!handoffId) return null;
  await pool.query(
    `INSERT INTO mcp_handoff_events (handoff_id, event_type, action_type)
     VALUES ($1, 'attributed_action', $2)`,
    [handoffId, actionType],
  ).catch(() => {});
  return handoffId;
}

export const MCP_ATTRIBUTION = {
  cookieName: COOKIE_NAME,
  cookieMaxAge: ATTRIBUTION_TTL_SECONDS,
};
