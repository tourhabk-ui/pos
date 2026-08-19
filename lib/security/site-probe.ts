/**
 * lib/security/site-probe.ts
 *
 * Съём внешней поверхности сайта. Сеть живёт ЗДЕСЬ и только здесь: правила
 * разбора (lib/security/site-audit.ts) должны судиться тестами, а не прогоном
 * по живому чужому сайту.
 *
 * Бюджет запросов жёсткий: один заход на корень, один на http:// ради
 * перенаправления и по одному на каждый служебный путь. Никаких повторов,
 * никакого параллельного шквала — оператор не должен замечать нас по нагрузке.
 */

import { connect as tlsConnect } from 'node:tls';
import {
  REQUEST_BUDGET, USER_AGENT, SENSITIVE_PATHS, isAuditableUrl,
  type SiteSnapshot,
} from '@/lib/security/site-audit';

const TIMEOUT_MS = 12_000;
const HTML_LIMIT = 200_000;

/** Срок сертификата — через TLS-рукопожатие: в fetch этих данных нет. */
export async function certDaysLeft(hostname: string, port = 443): Promise<number | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: number | null): void => { if (!done) { done = true; resolve(v); } };
    try {
      const socket = tlsConnect(
        { host: hostname, port, servername: hostname, timeout: TIMEOUT_MS, rejectUnauthorized: false },
        () => {
          const cert = socket.getPeerCertificate();
          socket.end();
          if (!cert || !cert.valid_to) return finish(null);
          const until = Date.parse(cert.valid_to);
          if (Number.isNaN(until)) return finish(null);
          finish(Math.floor((until - Date.now()) / 86_400_000));
        },
      );
      socket.on('error', () => finish(null));
      socket.on('timeout', () => { socket.destroy(); finish(null); });
    } catch {
      finish(null);
    }
  });
}

async function get(url: string, method: 'GET' | 'HEAD' = 'GET'): Promise<Response | null> {
  try {
    return await fetch(url, {
      method,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,*/*' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return null;
  }
}

/**
 * Снять сайт. Ошибка не бросается наружу: недоступность — это ИСХОД проверки,
 * а не сбой прогона, и она обязана доехать до отчёта словами.
 */
export async function probeSite(rawUrl: string): Promise<SiteSnapshot> {
  const empty: SiteSnapshot = {
    finalUrl: null, status: null, headers: {}, html: null, certDaysLeft: null,
    httpRedirectsToHttps: null, exposedPaths: [], pathsProbed: false, failure: null,
  };

  if (!isAuditableUrl(rawUrl)) {
    return { ...empty, failure: 'адрес не годится для проверки (не внешний http(s)-адрес)' };
  }
  const url = new URL(rawUrl.trim());

  let spent = 0;
  const root = await get(url.toString());
  spent++;
  if (!root) {
    return { ...empty, failure: 'нет ответа: имя не разрешилось, отказ соединения или таймаут' };
  }

  const headers: Record<string, string> = {};
  root.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });

  let html: string | null = null;
  try {
    const text = await root.text();
    html = text.slice(0, HTML_LIMIT);
  } catch {
    html = null;
  }

  const finalUrl = root.url || url.toString();
  const isHttps = finalUrl.startsWith('https://');

  const days = isHttps ? await certDaysLeft(new URL(finalUrl).hostname) : null;

  // Перенаправление с http:// — отдельный заход, но только если сайт на https.
  let httpRedirectsToHttps: boolean | null = null;
  if (isHttps && spent < REQUEST_BUDGET) {
    const plain = new URL(finalUrl);
    plain.protocol = 'http:';
    const res = await get(plain.toString(), 'HEAD');
    spent++;
    httpRedirectsToHttps = res ? res.url.startsWith('https://') : null;
  }

  // Служебные пути. Мы их НЕ читаем и не используем — фиксируем, что открыты.
  const exposedPaths: string[] = [];
  let pathsProbed = false;
  for (const p of SENSITIVE_PATHS) {
    if (spent >= REQUEST_BUDGET) break;
    const res = await get(new URL(p, finalUrl).toString(), 'HEAD');
    spent++;
    pathsProbed = true;
    // 200 на такой путь — уже происшествие. Всё прочее (403/404/редирект на
    // страницу-заглушку) считаем закрытым.
    if (res && res.status === 200) exposedPaths.push(p);
  }

  return {
    finalUrl, status: root.status, headers, html,
    certDaysLeft: days, httpRedirectsToHttps, exposedPaths, pathsProbed, failure: null,
  };
}
