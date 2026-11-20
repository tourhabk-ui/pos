/**
 * lib/mcp/pending-request.ts — заявка внешнего ИИ-агента ждёт, пока её
 * отправит сам человек (#3399, п. 4; слово владельца 15.11 «Делай»).
 *
 * Первый вызов заявки MCP или A2A проходит все проверки, но ничего не пишет
 * и никому не передаёт: заявка ложится сюда (миграция 1447), агент получает
 * черновик и ссылку на /confirm. Человек на странице видит, что и кому уйдёт,
 * ставит галочку согласия и нажимает «Отправить» — только тогда сервер
 * записывает заявку (lib/mcp/pending-confirm), а согласие пишется как данное
 * человеком на странице, а не агентом.
 *
 * До этого согласие заявлял агент: сначала флагом consent, потом кодом
 * подтверждения, который тот же агент и гасил (ревью безопасности #3414).
 *
 * Ссылка несёт токен; в базе — только его sha256. Аргументы (с именем и
 * телефоном) стираются в том же запросе, что отмечает отправку, — второе
 * нажатие ничего не найдёт; просроченные строки удаляет следующая запись.
 */
import { createHash, randomBytes } from 'node:crypto';
import { pool } from '@/lib/db-pool';
import { getPublicBaseUrl } from '@/lib/config';
import type { PdConsentPurpose } from '@/lib/legal/pd-consent';

const PD_PURPOSES: readonly PdConsentPurpose[] = ['operator', 'operators', 'stay', 'carrier', 'gear', 'rental', 'partner-signer'];
const isPurpose = (v: unknown): v is PdConsentPurpose => typeof v === 'string' && (PD_PURPOSES as readonly string[]).includes(v);

/** Сколько ждёт отложенная заявка. */
export const PENDING_REQUEST_TTL_MIN = 60;

export type PendingVia = 'mcp' | 'a2a';

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

function sqlState(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'нет кода';
}

/** Адрес страницы, где человек отправляет заявку. Токен — во фрагменте: в логи сервера он не попадает. */
export function confirmPageUrl(token: string): string {
  return `${getPublicBaseUrl()}/confirm#${token}`;
}

/**
 * Черновик отмены или переноса заявки (change_request, слово владельца 20.11
 * «1 для всех агентов»). Лежит в той же таблице под именем инструмента; в
 * аргументах — hash ключа заявки, действие и дата, без ПД и без самого ключа.
 */
export const PENDING_CHANGE_TOOL = 'change_request';

/** Адрес страницы, где человек сам подтверждает отмену или перенос заявки. */
export function confirmChangePageUrl(token: string): string {
  return `${getPublicBaseUrl()}/confirm/change#${token}`;
}

/** Токен из ссылки: 32 знака base64url. Чужое — не токен. */
export function isPendingToken(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{32}$/.test(v);
}

/**
 * Отложить заявку. Возвращает токен для ссылки или null — база не ответила
 * (вызывающий говорит «не удалось подготовить», а не «готово»).
 */
export async function createPendingRequest(p: {
  tool: string;
  args: Record<string, unknown>;
  draftText: string;
  /** Чьи тексты согласия запишет отправка — из прохода исполнителя (ctx.draftPurposes). */
  consentPurposes: PdConsentPurpose[];
  planRevision: string | null;
  via: PendingVia;
}): Promise<string | null> {
  const token = randomBytes(24).toString('base64url');
  try {
    // Просроченные заявки уносят с собой имя и телефон: удаляются здесь же.
    await pool.query(`DELETE FROM mcp_pending_requests WHERE expires_at < NOW() OR sent_at < NOW() - INTERVAL '1 day'`);
    await pool.query(
      `INSERT INTO mcp_pending_requests (token_hash, tool, args, draft_text, consent_purposes, plan_revision, via, expires_at)
       VALUES ($1, $2, $3::jsonb, $4, $5::text[], $6, $7, NOW() + make_interval(mins => $8::int))`,
      [hashToken(token), p.tool, JSON.stringify(p.args), p.draftText, p.consentPurposes, p.planRevision, p.via, PENDING_REQUEST_TTL_MIN],
    );
    return token;
  } catch (err) {
    console.error('[mcp-pending] заявка не отложена, SQLSTATE', sqlState(err));
    return null;
  }
}

export type PendingRead =
  | { kind: 'found'; tool: string; draftText: string; name: string; phone: string; comment: string; consentPurposes: PdConsentPurpose[]; expiresAt: string; parts: { tour: boolean; stay: boolean; transfer: boolean; carrier: boolean } }
  | { kind: 'sent' }
  | { kind: 'expired' }
  | { kind: 'missing' }
  | { kind: 'failed' };

/** Что показать человеку на странице. Отправленная — без данных: они стёрты. */
export async function readPendingRequest(token: string): Promise<PendingRead> {
  try {
    const { rows } = await pool.query<{ tool: string; args: Record<string, unknown>; draft_text: string; consent_purposes: string[] | null; expires_at: Date | string; sent_at: Date | string | null; expired: boolean }>(
      `SELECT tool, args, draft_text, consent_purposes, expires_at, sent_at, expires_at < NOW() AS expired
         FROM mcp_pending_requests WHERE token_hash = $1`,
      [hashToken(token)],
    );
    const r = rows[0];
    if (!r) return { kind: 'missing' };
    if (r.sent_at) return { kind: 'sent' };
    if (r.expired) return { kind: 'expired' };
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    return {
      kind: 'found',
      tool: r.tool,
      draftText: r.draft_text,
      name: str(r.args.name),
      phone: str(r.args.phone),
      // Комментарий уходит адресату вместе с заявкой — человек должен его видеть.
      comment: str(r.args.comment),
      consentPurposes: (r.consent_purposes ?? []).filter(isPurpose),
      expiresAt: new Date(r.expires_at).toISOString(),
      parts: { tour: Boolean(r.args.tour), stay: Boolean(r.args.stay), transfer: Boolean(r.args.transfer_destination || r.args.stay_wanted), carrier: Boolean(r.args.carrier) },
    };
  } catch (err) {
    console.error('[mcp-pending] заявка не прочитана, SQLSTATE', sqlState(err));
    return { kind: 'failed' };
  }
}

export type PendingClaim =
  | { kind: 'claimed'; tool: string; args: Record<string, unknown>; planRevision: string | null; via: PendingVia }
  | { kind: 'gone' }
  | { kind: 'failed' };

/**
 * Забрать заявку на отправку — один раз. В том же запросе отмечается
 * отправка и стираются аргументы: второе нажатие (или второй вкладкой)
 * получит 'gone'. Просроченная тоже 'gone'.
 *
 * `kind` — какая дверь забирает: отправка заявки ('request') черновик
 * изменения не забирает, а подтверждение изменения ('change') — заявку.
 * Условие стоит в самом запросе: чужая дверь видит 'gone' и ничего не стирает.
 */
export async function claimPendingRequest(token: string, kind: 'request' | 'change' = 'request'): Promise<PendingClaim> {
  try {
    const { rows } = await pool.query<{ tool: string; args: Record<string, unknown>; plan_revision: string | null; via: string }>(
      `WITH old AS (
         SELECT id, tool, args, plan_revision, via FROM mcp_pending_requests
          WHERE token_hash = $1 AND sent_at IS NULL AND expires_at > NOW()
            AND (tool = $3) = $2::boolean
          FOR UPDATE
       )
       UPDATE mcp_pending_requests t
          SET sent_at = NOW(), args = '{}'::jsonb
         FROM old
        WHERE t.id = old.id
       RETURNING old.tool, old.args, old.plan_revision, old.via`,
      [hashToken(token), kind === 'change', PENDING_CHANGE_TOOL],
    );
    const r = rows[0];
    if (!r) return { kind: 'gone' };
    return { kind: 'claimed', tool: r.tool, args: r.args, planRevision: r.plan_revision, via: r.via === 'a2a' ? 'a2a' : 'mcp' };
  } catch (err) {
    console.error('[mcp-pending] заявка не забрана, SQLSTATE', sqlState(err));
    return { kind: 'failed' };
  }
}

/**
 * Вернуть заявку в ожидание: отправка не дошла до исполнителя по причине,
 * которая пройдёт сама (лимит заявок с адреса, сбой базы). Иначе человек
 * терял бы заявку из-за нашей временной беды и шёл бы к агенту заново.
 * Отказ по существу (тура нет, телефон негодный) заявку не возвращает.
 */
export async function releasePendingRequest(token: string, args: Record<string, unknown>): Promise<boolean> {
  try {
    const { rowCount } = await pool.query(
      `UPDATE mcp_pending_requests SET sent_at = NULL, args = $2::jsonb
        WHERE token_hash = $1 AND sent_at IS NOT NULL AND expires_at > NOW()`,
      [hashToken(token), JSON.stringify(args)],
    );
    return (rowCount ?? 0) > 0;
  } catch (err) {
    console.error('[mcp-pending] заявка не возвращена в ожидание, SQLSTATE', sqlState(err));
    return false;
  }
}

/**
 * Запрос похож на запрос со страницы Ведара в браузере (ревью безопасности
 * #3418): Origin — этот сайт, и браузер не назвал его чужим (Sec-Fetch-Site).
 * Это барьер, а не доказательство: ссылку получает и сам агент, и вызов по
 * ней «в лоб» (без Origin) получает отказ, но серверный запрос может
 * подставить заголовки, а агент с браузером — нажать сам. Доказательство
 * человека дал бы только код на его телефон (решение владельца).
 */
export function fromVedarPage(headers: Headers): boolean {
  const site = headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin') return false;
  const origin = headers.get('origin');
  if (!origin) return false;
  try {
    const host = new URL(origin).host;
    return host === new URL(getPublicBaseUrl()).host
      || host === headers.get('x-forwarded-host')
      || host === headers.get('host');
  } catch {
    return false;
  }
}

/** Номер телефона на странице — последние четыре цифры. */
export function maskedPhone(raw: string): string {
  const d = raw.replace(/\D/g, '');
  return d.length >= 4 ? `+${d.slice(0, 1)} *** ***-${d.slice(-4, -2)}-${d.slice(-2)}` : '***';
}
