/**
 * Cron authentication helpers.
 * Works with both NextRequest (has nextUrl) and plain Request (Web API).
 */

type AnyRequest = { headers: { get(name: string): string | null }; url: string };

/**
 * Reads cron secret from Authorization: Bearer header (preferred)
 * or falls back to ?secret= query param for backward compatibility.
 */
export function getCronSecret(request: AnyRequest): string | null {
  const fromHeader = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
  if (fromHeader) return fromHeader;
  try {
    return new URL(request.url).searchParams.get('secret');
  } catch {
    return null;
  }
}

/**
 * ── Почему 401 обязан объяснять себя ─────────────────────────────────────
 *
 * 29.08 владелец завёл внешний планировщик и получил `{"error":"Unauthorized"}`
 * без единой подробности. Из этого ответа неразличимы три РАЗНЫЕ беды, и
 * чинятся они в трёх разных местах:
 *
 *   - секрет не дошёл вовсе (не тот заголовок, потерян параметр) — чинить
 *     настройку джоба;
 *   - секрет дошёл, но не совпал — чинить значение (у нас их гуляло два);
 *   - `CRON_SECRET` не задан на СЕРВЕРЕ — чинить переменные Timeweb, и никакая
 *     правка джоба не поможет.
 *
 * Молчаливый 401 схлопывает их в одну строку и отправляет искать наугад.
 *
 * ── Что можно показать, а что нельзя ─────────────────────────────────────
 *
 * Отпечаток ПОЛУЧЕННОГО секрета показать можно: это секрет самого
 * вызывающего, он его и прислал, нового знания в ответе не появляется. По
 * отпечатку сразу видно, какое из двух значений реально уходит.
 *
 * Отпечаток ОЖИДАЕМОГО показывать нельзя, хотя соблазн велик и в репозитории
 * есть прецедент (`lib/ai/key-identity.ts`). Разница в том, что там отпечаток
 * живёт на админской странице, а здесь — в ответе НЕАВТОРИЗОВАННОМУ. Отдать
 * 32 бита хеша от настоящего секрета кому угодно значит превратить перебор из
 * сетевого в офлайновый. Диагностике это не нужно: сравнить полученный
 * отпечаток с ожидаемым владелец может у себя в панели.
 */
export type CronAuthFailure = 'missing' | 'mismatch' | 'server_unset';

export interface CronAuthDiagnosis {
  reason: CronAuthFailure;
  /** По-русски, для человека, который смотрит в панель планировщика. */
  hint: string;
  /** Отпечаток ПОЛУЧЕННОГО секрета (8 hex от SHA-256); null — секрета не было. */
  got_fingerprint: string | null;
}

function fingerprint(value: string): string {
  // require, а не import: файл зовут и из edge-контекста, где статический
  // импорт node:crypto ломает сборку. Отказ хеширования не должен ронять
  // ответ — диагностика не важнее самого отказа в доступе.
  try {

    const { createHash } = require('node:crypto') as typeof import('node:crypto');
    return createHash('sha256').update(value).digest('hex').slice(0, 8);
  } catch {
    return 'unavailable';
  }
}

/**
 * Почему не пустили. Зовётся ТОЛЬКО после неуспешной проверки — сам решения
 * о доступе не принимает.
 */
export function diagnoseCronAuth(request: AnyRequest): CronAuthDiagnosis {
  const provided = getCronSecret(request);
  const expected = process.env.CRON_SECRET;

  if (!expected) {
    return {
      reason: 'server_unset',
      hint: 'CRON_SECRET не задан на сервере — правка джоба не поможет, смотри переменные окружения приложения',
      got_fingerprint: provided ? fingerprint(provided) : null,
    };
  }
  if (!provided) {
    return {
      reason: 'missing',
      hint: 'секрет не передан ни заголовком Authorization: Bearer, ни параметром ?secret= — проверь настройку джоба',
      got_fingerprint: null,
    };
  }
  return {
    reason: 'mismatch',
    hint: 'секрет получен, но не совпал с серверным — сверь отпечаток ниже с текущим значением CRON_SECRET в панели',
    got_fingerprint: fingerprint(provided),
  };
}

export function verifyCronSecret(request: AnyRequest): boolean {
  const provided = getCronSecret(request);
  const expected = process.env.CRON_SECRET;
  if (!provided || !expected) return false;
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}
