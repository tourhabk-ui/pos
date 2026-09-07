/**
 * Кого пускать к записи через публичный MCP (policy v3, аудит 07.09).
 *
 * ── Что было ──────────────────────────────────────────────────────────────
 *
 * Публичный MCP без авторизации — решение владельца, и оно остаётся: манифест
 * объявляет `"authentication": "none"`, чтение открыто. Но на записи стоял
 * счётчик в памяти процесса (`lib/rate-limit.ts`, `new Map`): он обнуляется
 * при каждом рестарте контейнера и не существует между инстансами. То есть
 * анонимный приём персональных данных удерживался ограничением, которого
 * фактически не было, — и по виду кода это выглядело защитой.
 *
 * ── Три вопроса, а не один ────────────────────────────────────────────────
 *
 * Решение собирается из трёх независимых проверок, и каждая ловит свой поток:
 *
 *   1. СОГЛАСИЕ. Анонимный клиент присылает чужой телефон и имя. Без явного
 *      согласия это приём ПД без основания. Раньше MCP не записывал согласие
 *      ВООБЩЕ — `buildConsentRecord` честно возвращал null («не спрашивали»),
 *      и это было верно как факт, но негодно как позиция.
 *   2. ЧАСТОТА С АДРЕСА. Поток заявок с одного клиента.
 *   3. ПОВТОР ТЕЛЕФОНА. Тот же номер с разных адресов — так выглядит и
 *      настоящая атака, и сломавшийся агент в цикле.
 *
 * ── Третий исход обязателен (§4.0) ────────────────────────────────────────
 *
 * У проверки три ответа: «можно», «нельзя» и «не смог проверить». Третий
 * ЗДЕСЬ не решает — решает вызывающий. Для анонимной записи ПД вызывающий
 * обязан читать «не смог» как отказ: пропустить непроверенное значит выдать
 * отсутствие проверки за её прохождение. Практически это ничего не теряет —
 * счёт живёт в той же базе, что и сам лид: не смогли посчитать, значит и
 * записать не смогли бы.
 *
 * ── Персональных данных в журнале нет ─────────────────────────────────────
 *
 * Ни телефона, ни имени, ни адреса — только необратимые отпечатки с секретной
 * солью. Защита от утечки ПД, сама ставшая вторым хранилищем ПД, — это не
 * защита.
 */

import { createHash } from 'node:crypto';
import { pool } from '@/lib/db-pool';

/** Окно и потолок на клиента: столько же, сколько держал счётчик в памяти. */
export const CLIENT_WINDOW_MINUTES = 10;
export const CLIENT_MAX_PER_WINDOW = 5;
/** Суточный потолок на клиента — от медленного равномерного потока. */
export const CLIENT_MAX_PER_DAY = 20;
/** Сколько заявок на ОДИН номер терпим за сутки. */
export const PHONE_MAX_PER_DAY = 3;

export type WriteOutcome = 'allowed' | 'rate_limited' | 'quarantined' | 'no_consent' | 'unknown';

export type WriteDecision =
  | { decision: 'allow' }
  | { decision: 'deny'; outcome: Exclude<WriteOutcome, 'allowed' | 'unknown'>; message: string }
  | { decision: 'unknown'; message: string };

/**
 * Соль отпечатков. Отдельная переменная, с откатом на CRON_SECRET: он и так
 * обязателен при старте (`validateConfig`), поэтому «соли нет» на практике
 * означает «приложение не настроено», а не «забыли про MCP».
 *
 * Соли нет — отпечаток не строится и решение становится «не смог». Считать
 * без соли нельзя: sha256 от адреса IPv4 перебирается за секунды и адресом
 * же и остаётся.
 */
function salt(): string | null {
  return process.env.MCP_HASH_SALT || process.env.CRON_SECRET || null;
}

function fingerprint(value: string, s: string): string {
  return createHash('sha256').update(`${s}:${value}`).digest('hex');
}

export interface WriteGuardInput {
  /** Адрес клиента как его видит роут. В журнал не попадает — только отпечаток. */
  ip: string;
  userAgent: string;
  tool: string;
  /** Нормализованный телефон. В журнал не попадает — только отпечаток. */
  phone: string | null;
  /** Прислал ли клиент явное согласие на обработку ПД. */
  consent: boolean;
}

interface Counts {
  by_client_window: number;
  by_client_day: number;
  by_phone_day: number;
}

/**
 * Решение по одной попытке записи. Ничего не пишет в лиды и ничего не
 * отправляет — только считает и объясняет.
 */
export async function checkMcpWrite(input: WriteGuardInput): Promise<WriteDecision> {
  const s = salt();
  const clientKey = s ? fingerprint(`${input.ip}|${input.userAgent}`, s) : null;
  const phoneHash = s && input.phone ? fingerprint(input.phone, s) : null;

  // Согласие спрашивается ПЕРВЫМ и не зависит ни от базы, ни от настроек.
  //
  // Порядок здесь не косметика. В первой редакции проверка соли стояла выше,
  // и в среде без соли отказ «нет согласия» подменялся ответом «не смог
  // посчитать поток»: агенту сообщали про нашу конфигурацию вместо того, что
  // от него требуется. Основание отказа обязано быть настоящим — иначе агент
  // будет чинить не то и повторять запрос, который никогда не пройдёт.
  //
  // Запись попытки при этом может не получиться (без соли отпечатка нет) —
  // решение от этого не меняется, а пропуск строки в журнале виден в логе.
  if (!input.consent) {
    if (clientKey) await record(clientKey, input.tool, phoneHash, 'no_consent');
    else console.error('[mcp-write-guard] отказ по согласию не записан: соль отпечатков не настроена');
    return {
      decision: 'deny',
      outcome: 'no_consent',
      message:
        'Заявка не создана: нет согласия на обработку персональных данных. '
        + 'Спросите человека прямо и передайте consent: true — без этого имя и телефон принимать нельзя.',
    };
  }

  if (!s || !clientKey) {
    return {
      decision: 'unknown',
      message: 'Соль отпечатков не настроена (MCP_HASH_SALT или CRON_SECRET) — посчитать поток нечем.',
    };
  }

  let counts: Counts;
  try {
    // Приведения у параметров явные: форма «сравнение с колонкой внутри
    // FILTER» выводом типов не покрыта так же надёжно, как обычный WHERE,
    // а цена ошибки здесь — 42P08 на живом пути (случай 24.08 в CLAUDE.md).
    const { rows } = await pool.query<{ a: string; b: string; c: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE client_key = $1::char(64)
                            AND created_at > NOW() - (INTERVAL '1 minute' * $3::int))::text AS a,
         COUNT(*) FILTER (WHERE client_key = $1::char(64))::text AS b,
         COUNT(*) FILTER (WHERE $2::char(64) IS NOT NULL AND phone_hash = $2::char(64))::text AS c
       FROM mcp_write_attempts
       WHERE created_at > NOW() - INTERVAL '24 hours'`,
      [clientKey, phoneHash, String(CLIENT_WINDOW_MINUTES)],
    );
    counts = {
      by_client_window: Number(rows[0]?.a ?? 0),
      by_client_day: Number(rows[0]?.b ?? 0),
      by_phone_day: Number(rows[0]?.c ?? 0),
    };
  } catch (err) {
    // Молчать нельзя: отказ проверки, выданный за её прохождение, — ровно тот
    // дефект, ради которого §4.0 и написан.
    console.error('[mcp-write-guard] не смог посчитать поток:', err);
    return {
      decision: 'unknown',
      message: 'Не удалось проверить ограничения — заявка не создана. Повторите позже.',
    };
  }

  if (counts.by_phone_day >= PHONE_MAX_PER_DAY) {
    await record(clientKey, input.tool, phoneHash, 'quarantined');
    return {
      decision: 'deny',
      outcome: 'quarantined',
      message:
        `На этот номер уже ${counts.by_phone_day} заявки за сутки — новую не создаю. `
        + 'Если заявка настоящая, менеджер свяжется по предыдущей.',
    };
  }

  if (counts.by_client_window >= CLIENT_MAX_PER_WINDOW || counts.by_client_day >= CLIENT_MAX_PER_DAY) {
    await record(clientKey, input.tool, phoneHash, 'rate_limited');
    return {
      decision: 'deny',
      outcome: 'rate_limited',
      message: `Слишком много заявок подряд — подождите ${CLIENT_WINDOW_MINUTES} минут и повторите.`,
    };
  }

  await record(clientKey, input.tool, phoneHash, 'allowed');
  return { decision: 'allow' };
}

/**
 * Запись попытки. Пишутся ВСЕ исходы, включая отказы: иначе поток отказов не
 * считает сам себя, и ограничение обходится повторением того, что уже
 * отвергли.
 *
 * Отказ записи журнала не ломает решение — оно уже принято выше. Но и не
 * глушится: без строки в логе журнал, переставший писаться, выглядел бы как
 * «попыток не было».
 */
async function record(
  clientKey: string,
  tool: string,
  phoneHash: string | null,
  outcome: WriteOutcome,
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO mcp_write_attempts (client_key, tool, phone_hash, outcome)
       VALUES ($1::char(64), $2::varchar(64), $3::char(64), $4::varchar(16))`,
      [clientKey, tool, phoneHash, outcome],
    );
    // Уборка попутно и редко: счёт смотрит только на сутки, хранить год
    // незачем, а отдельный крон ради одной таблицы — лишняя сущность в
    // реестре. Раз в полсотни записей дешевле, чем ежедневный прогон.
    if (Math.random() < 0.02) {
      await pool.query(`DELETE FROM mcp_write_attempts WHERE created_at < NOW() - INTERVAL '30 days'`);
    }
  } catch (err) {
    console.error('[mcp-write-guard] не смог записать попытку:', err);
  }
}
