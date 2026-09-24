/**
 * Внешний сторож сторожа: сигнал «Watchdog жив» на healthchecks.io.
 *
 * Watchdog сторожит все кроны платформы, но сам себя не сторожит никто:
 * умри он (или весь прод) — сказать об этом было некому, и тишина в
 * Telegram читалась как «всё спокойно». Внешний сервис ждёт сигнал каждые
 * полчаса и сам пишет в Telegram, когда сигнал пропал (решение владельца
 * 24.09, «давай оба, начни с healthchecks»).
 *
 * Шлётся с ПРОДА, из роута, а не шагом workflow: сигнал обязан значить
 * «проверки выполнились», а не «планировщик GitHub вспомнил про крон».
 *
 * Адрес — секрет (кто знает адрес, тот может слать «жив»), поэтому только
 * env `HEALTHCHECKS_WATCHDOG_URL` в переменных Timeweb, не в репозитории.
 *
 * Исходов четыре, и ни один не молчит (§4.0): отправлено; не настроено
 * (адреса нет — законно, до регистрации); адрес не похож на healthchecks
 * (опечатка в панели — не шлём наугад куда попало); не дошло (сеть,
 * гео-блок, код не 2xx — с причиной).
 */

export const HEALTHCHECKS_ENV = 'HEALTHCHECKS_WATCHDOG_URL';

/** Хосты пинга healthchecks.io. Свой инстанс — отдельным решением. */
const PING_HOSTS = new Set(['hc-ping.com']);

export type HeartbeatOutcome =
  | { state: 'sent'; signal: 'ok' | 'fail' }
  | { state: 'not_configured' }
  | { state: 'misconfigured'; reason: string }
  | { state: 'failed'; signal: 'ok' | 'fail'; reason: string };

/** Проверить адрес из env. null — адреса нет вовсе. */
export function parsePingUrl(raw: string | undefined): URL | { error: string } | null {
  const v = raw?.trim();
  if (!v) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return { error: 'адрес не разбирается как URL' };
  }
  if (u.protocol !== 'https:') return { error: 'нужен https' };
  if (!PING_HOSTS.has(u.hostname)) return { error: `хост ${u.hostname} — не healthchecks.io` };
  if (u.pathname.length < 2) return { error: 'в адресе нет идентификатора проверки' };
  return u;
}

/**
 * Какой сигнал слать по итогу прогона Watchdog.
 *
 * Не выполнилась одна-две проверки — это Watchdog уже пишет сам (статус
 * partial), и дублировать это вечной красной лампой снаружи значит приучить
 * её игнорировать. А вот когда не выполнилась половина и больше — Watchdog
 * ослеп: так выглядит упавшая БД, при которой все проверки падают разом и
 * «нарушений нет» было бы враньём. Тогда — `fail`, и тревогу поднимет уже
 * внешний сервис, которому наша БД не нужна.
 */
export function watchdogSignal(total: number, failed: number): 'ok' | 'fail' {
  if (total <= 0) return 'fail';
  return failed * 2 >= total ? 'fail' : 'ok';
}

/**
 * Отправить сигнал. Тело — короткая сводка без персональных данных, она
 * видна в журнале проверки на healthchecks.io.
 */
export async function pingHeartbeat(
  signal: 'ok' | 'fail',
  summary: string,
  deps: { env?: Record<string, string | undefined>; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<HeartbeatOutcome> {
  const env = deps.env ?? process.env;
  const parsed = parsePingUrl(env[HEALTHCHECKS_ENV]);
  if (parsed === null) return { state: 'not_configured' };
  if (!(parsed instanceof URL)) {
    console.error(`[heartbeat] ${HEALTHCHECKS_ENV} отвергнут: ${parsed.error}`);
    return { state: 'misconfigured', reason: parsed.error };
  }
  const target = new URL(parsed.toString());
  if (signal === 'fail') target.pathname = target.pathname.replace(/\/$/, '') + '/fail';
  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const res = await doFetch(target.toString(), {
      method: 'POST',
      body: summary.slice(0, 1000),
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      signal: AbortSignal.timeout(deps.timeoutMs ?? 8000),
    });
    if (!res.ok) {
      const reason = `HTTP ${res.status}`;
      console.error(`[heartbeat] сигнал ${signal} не принят: ${reason}`);
      return { state: 'failed', signal, reason };
    }
    return { state: 'sent', signal };
  } catch (err) {
    const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(`[heartbeat] сигнал ${signal} не дошёл: ${reason}`);
    return { state: 'failed', signal, reason };
  }
}
