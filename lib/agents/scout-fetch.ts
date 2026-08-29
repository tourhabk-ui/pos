/**
 * lib/agents/scout-fetch.ts — чтение чужой страницы для разведчика.
 *
 * Адрес приходит СНАРУЖИ (параметр запроса), поэтому обращение с ним такое
 * же строгое, как в lib/security/site-probe.ts, откуда взят порядок проверок:
 *
 *   - форма адреса судится isAuditableUrl (только http/https, не IP-литерал);
 *   - имя хоста разрешается в DNS, и приватные адреса отсекаются;
 *   - перенаправления идём ВРУЧНУЮ и судим каждый следующий адрес заново.
 *
 * Последнее — не перестраховка: проверка только исходного адреса бесполезна,
 * потому что чужой сайт вправе ответить `302 Location: http://169.254.169.254/`,
 * то есть на метаданные облака. Небезопасен КАЖДЫЙ переход, а не первый.
 *
 * Ошибка не бросается наружу: недоступность источника — это ИСХОД разведки,
 * который обязан доехать до отчёта словами, а не обвалить прогон (§4.0).
 */

import { lookup } from 'node:dns/promises';
import { isAuditableUrl, isPrivateAddress } from '@/lib/security/site-audit';

const TIMEOUT_MS = 15_000;
const MAX_HOPS = 5;
/** Потолок вычитываемого: страница-гигант не должна съесть память процесса. */
const BODY_LIMIT = 600_000;

const USER_AGENT = 'VedarScout/1.0 (+https://vedarai.ru)';

export type FetchResult =
  | { ok: true; body: string; finalUrl: string; truncated: boolean }
  | { ok: false; reason: string };

/** Все ли адреса имени публичные. Ошибка разрешения — «нет», а не «да». */
async function resolvesPublic(hostname: string): Promise<boolean> {
  try {
    const addrs = await lookup(hostname, { all: true });
    if (addrs.length === 0) return false;
    return addrs.every(a => !isPrivateAddress(a.address));
  } catch {
    return false;
  }
}

/**
 * Прочитать страницу. Возвращает текст тела или НАЗВАННУЮ причину отказа —
 * причина уходит человеку в ответ, поэтому она на русском и по делу.
 */
export async function safeFetchText(rawUrl: string): Promise<FetchResult> {
  let current = rawUrl;

  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    if (!isAuditableUrl(current)) {
      return { ok: false, reason: `адрес не годится для чтения: ${current.slice(0, 120)}` };
    }

    let host: string;
    try {
      host = new URL(current).hostname;
    } catch {
      return { ok: false, reason: `адрес не разбирается: ${current.slice(0, 120)}` };
    }

    if (!(await resolvesPublic(host))) {
      return { ok: false, reason: `имя ${host} не разрешается в публичный адрес` };
    }

    let res: Response;
    try {
      res = await fetch(current, {
        redirect: 'manual',
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,text/plain,*/*' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `запрос не прошёл: ${message}` };
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) {
        return { ok: false, reason: `перенаправление ${res.status} без адреса` };
      }
      try {
        current = new URL(loc, current).toString();
      } catch {
        return { ok: false, reason: `перенаправление ведёт на неразбираемый адрес` };
      }
      continue;
    }

    if (!res.ok) {
      return { ok: false, reason: `источник ответил ${res.status}` };
    }

    let body: string;
    try {
      body = await res.text();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `тело не прочиталось: ${message}` };
    }

    const truncated = body.length > BODY_LIMIT;
    return {
      ok: true,
      body: truncated ? body.slice(0, BODY_LIMIT) : body,
      finalUrl: current,
      truncated,
    };
  }

  return { ok: false, reason: `слишком много перенаправлений (> ${MAX_HOPS})` };
}
