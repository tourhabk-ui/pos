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
import { lookup } from 'node:dns/promises';
import {
  REQUEST_BUDGET, USER_AGENT, SENSITIVE_PATHS, isAuditableUrl, isPrivateAddress,
  type SiteSnapshot,
} from '@/lib/security/site-audit';

const TIMEOUT_MS = 12_000;
const HTML_LIMIT = 200_000;

/** Что удалось узнать о сертификате: срок и доверие — РАЗНЫЕ вопросы. */
export interface CertProbe {
  /** Сколько суток осталось по полю valid_to. null — снять не удалось. */
  daysLeft: number | null;
  /** Прошёл ли сертификат проверку цепочки и имени. null — не выяснили. */
  trusted: boolean | null;
  /** Почему не прошёл: 'SELF_SIGNED_CERT_IN_CHAIN', 'ERR_TLS_CERT_ALTNAME_INVALID'. */
  untrustedReason: string | null;
}

/**
 * Сертификат — через TLS-рукопожатие: в fetch этих данных нет.
 *
 * `rejectUnauthorized: false` стоит НАМЕРЕННО и убрать его нельзя: аудит обязан
 * рассказать про плохой сертификат, а с включённой проверкой рукопожатие с ним
 * просто оборвётся, и мы получим то же «не смогли», что и от мёртвого сайта.
 *
 * Но до 23.08.2026 отсюда возвращался ТОЛЬКО срок, и этого было мало
 * (js/disabling-certificate-validation). `getPeerCertificate()` отдаёт то, что
 * прислали, независимо от проверки, а `auditSnapshot` превращал любое
 * положительное число в `outcome: 'ok'`. Самоподписанный сертификат с дальней
 * датой — или сертификат, выписанный на чужое имя, — получал зелёное
 * «действует ещё N суток», хотя браузер туриста показал бы предупреждение.
 *
 * Поэтому вердикт берётся не из даты, а из `socket.authorized`: узла TLS,
 * который знает результат проверки цепочки и сверки имени.
 */
export async function certDaysLeft(hostname: string, port = 443): Promise<CertProbe> {
  const unknown: CertProbe = { daysLeft: null, trusted: null, untrustedReason: null };
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: CertProbe): void => { if (!done) { done = true; resolve(v); } };
    try {
      const socket = tlsConnect(
        { host: hostname, port, servername: hostname, timeout: TIMEOUT_MS, rejectUnauthorized: false },
        () => {
          const cert = socket.getPeerCertificate();
          // Проверка ВЫКЛЮЧЕНА, но её результат узел всё равно посчитал.
          const trusted = socket.authorized;
          const reason = trusted ? null : (socket.authorizationError?.message ?? String(socket.authorizationError ?? 'причина не названа'));
          socket.end();
          if (!cert || !cert.valid_to) return finish({ daysLeft: null, trusted, untrustedReason: reason });
          const until = Date.parse(cert.valid_to);
          if (Number.isNaN(until)) return finish({ daysLeft: null, trusted, untrustedReason: reason });
          finish({
            daysLeft: Math.floor((until - Date.now()) / 86_400_000),
            trusted,
            untrustedReason: reason,
          });
        },
      );
      socket.on('error', () => finish(unknown));
      socket.on('timeout', () => { socket.destroy(); finish(unknown); });
    } catch {
      finish(unknown);
    }
  });
}

/** Сколько перенаправлений позволено пройти. */
const MAX_HOPS = 5;

/**
 * Разрешается ли имя в ПУБЛИЧНЫЙ адрес.
 *
 * Проверки имени мало: `internal.example.com` — внешнее имя, а разрешается в
 * 10.0.0.5. Спрашиваем DNS и смотрим на то, куда реально пойдёт запрос.
 * Не разрешилось — отказ, а не пропуск: «не знаю» здесь безопаснее «можно».
 */
async function resolvesPublic(hostname: string): Promise<boolean> {
  try {
    const addrs = await lookup(hostname, { all: true });
    if (addrs.length === 0) return false;
    return addrs.every((a) => !isPrivateAddress(a.address));
  } catch {
    return false;
  }
}

/**
 * Запрос с ПОШАГОВОЙ проверкой перенаправлений.
 *
 * `redirect: 'follow'` здесь был дырой, и CodeQL назвал её верно: адрес берётся
 * из БД, а чужой сайт вправе ответить `302 Location: http://169.254.169.254/`
 * — это метаданные облака, ради которых SSRF обычно и затевают. Проверка
 * исходного адреса от этого не спасает: небезопасен КАЖДЫЙ следующий переход.
 *
 * Поэтому переходы идём вручную и каждый следующий адрес судим заново — и по
 * форме (isAuditableUrl), и по тому, куда он разрешается в DNS.
 */
async function get(url: string, method: 'GET' | 'HEAD' = 'GET'): Promise<Response | null> {
  let current = url;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    if (!isAuditableUrl(current)) return null;
    let host: string;
    try {
      host = new URL(current).hostname;
    } catch {
      return null;
    }
    if (!(await resolvesPublic(host))) return null;

    let res: Response;
    try {
      res = await fetch(current, {
        method,
        redirect: 'manual',
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,*/*' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return null;
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return res;
      try {
        current = new URL(loc, current).toString();
      } catch {
        return null;
      }
      continue;
    }
    // Итоговый адрес — тот, по которому реально ответили: fetch с ручными
    // перенаправлениями не проставит res.url за нас.
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: (() => {
        const h = new Headers(res.headers);
        h.set('x-vedar-final-url', current);
        return h;
      })(),
    });
  }
  return null;
}

/** Куда в итоге пришли: адрес мы проставляем сами, см. get(). */
function finalUrlOf(res: Response, fallback: string): string {
  return res.headers.get('x-vedar-final-url') ?? res.url ?? fallback;
}

/**
 * Снять сайт. Ошибка не бросается наружу: недоступность — это ИСХОД проверки,
 * а не сбой прогона, и она обязана доехать до отчёта словами.
 */
export async function probeSite(rawUrl: string): Promise<SiteSnapshot> {
  const empty: SiteSnapshot = {
    finalUrl: null, status: null, headers: {}, html: null, certDaysLeft: null,
    certTrusted: null, certUntrustedReason: null,
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

  const finalUrl = finalUrlOf(root, url.toString());
  const isHttps = finalUrl.startsWith('https://');

  const cert = isHttps
    ? await certDaysLeft(new URL(finalUrl).hostname)
    : { daysLeft: null, trusted: null, untrustedReason: null };

  // Перенаправление с http:// — отдельный заход, но только если сайт на https.
  let httpRedirectsToHttps: boolean | null = null;
  if (isHttps && spent < REQUEST_BUDGET) {
    const plain = new URL(finalUrl);
    plain.protocol = 'http:';
    const res = await get(plain.toString(), 'HEAD');
    spent++;
    httpRedirectsToHttps = res ? finalUrlOf(res, plain.toString()).startsWith('https://') : null;
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
    certDaysLeft: cert.daysLeft, certTrusted: cert.trusted,
    certUntrustedReason: cert.untrustedReason,
    httpRedirectsToHttps, exposedPaths, pathsProbed, failure: null,
  };
}
