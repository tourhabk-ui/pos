/**
 * Что прокси перед приложением кладёт в заголовки адреса клиента — разбор
 * для пробы `GET /api/cron/client-ip-headers-probe` (находка P3-02 аудита
 * 15.10, долг 29.09 — docs/mcp/audit-2026-09-29.md, «Решения владельца»).
 *
 * Зачем. `getTrustedClientIp` доверяет `x-real-ip` в расчёте на то, что его
 * ставит прокси и снаружи его не подделать. Ставит ли его прокси Timeweb, из
 * репозитория не видно: `nginx.conf` в корне — шаблон для VPS, в образ он не
 * попадает. Если не ставит, доверенный порядок откатывается на
 * `cf-connecting-ip` и первый элемент X-Forwarded-For — оба пишет клиент, и
 * перевод 58 роутов с `getClientIp` на доверенный порядок был бы холостым.
 * Ответ даёт только запрос, прошедший настоящий прокси.
 *
 * Чего здесь НЕТ, намеренно: значений адресов. Адрес посетителя — ПД, а у
 * вызывающего пробу раннера — просто лишнее в логе Actions. Наружу уходят
 * присутствие заголовка, число элементов, РОД адреса (публичный, внутренний,
 * документационный…) и булевы сравнения. Сравнения считаются здесь, а не у
 * вызывающего, ровно чтобы значения не покидали процесс.
 *
 * Как отличить «прокси ставит сам» от «прокси пропускает клиентское». Род
 * `documentation` — адреса RFC 5737 / RFC 3849, у живого клиента их не бывает.
 * Проба шлёт такие в X-Real-IP, CF-Connecting-IP и X-Forwarded-For (и
 * говорит об этом `?forged=1`); дошёл документационный — прокси заголовок не
 * перезаписывает, и доверять ему нельзя.
 */

import { isIPv6 } from 'node:net';

export type AddrKind =
  | 'public'
  | 'private'        // RFC 1918, fc00::/7 — внутренняя сеть
  | 'loopback'
  | 'link_local'
  | 'cgnat'          // 100.64.0.0/10 — общий адрес оператора связи
  | 'documentation'  // RFC 5737, 2001:db8::/32 — живой клиент таких не имеет
  | 'reserved'       // 0.0.0.0/8, multicast и выше, «::»
  | 'not_an_ip';     // в заголовке не адрес вовсе («unknown», мусор)

/** Убрать порт и скобки: прокси пишут и `1.2.3.4:5678`, и `[2001:db8::1]:443`. */
function stripPort(raw: string): string {
  const v = raw.trim().toLowerCase();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(v);
  if (bracketed) return bracketed[1];
  const v4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(v);
  if (v4WithPort) return v4WithPort[1];
  return v;
}

function parseV4(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  return octets.every((n) => n <= 255) ? octets : null;
}

function classifyV4([a, b, c]: number[]): AddrKind {
  if (a === 127) return 'loopback';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat';
  if (a === 169 && b === 254) return 'link_local';
  if ((a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) {
    return 'documentation';
  }
  if (a === 0 || a >= 224) return 'reserved';
  return 'public';
}

/** Род адреса. Значение не возвращается — только род. */
export function classifyAddr(raw: string): AddrKind {
  const s = stripPort(raw);
  const v4 = parseV4(s);
  if (v4) return classifyV4(v4);
  if (!isIPv6(s)) return 'not_an_ip';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (mapped) {
    const inner = parseV4(mapped[1]);
    return inner ? classifyV4(inner) : 'not_an_ip';
  }
  if (s === '::1') return 'loopback';
  if (s === '::') return 'reserved';
  if (/^f[cd][0-9a-f]{0,2}:/.test(s)) return 'private';
  if (/^fe[89ab][0-9a-f]?:/.test(s)) return 'link_local';
  if (/^2001:0*db8:/.test(s)) return 'documentation';
  if (/^ff[0-9a-f]{0,2}:/.test(s)) return 'reserved';
  return 'public';
}

function splitList(value: string): string[] {
  return value.split(',').map((x) => x.trim()).filter((x) => x.length > 0);
}

/** Сравнение двух адресов без порта и регистра; null — сравнивать нечего. */
function sameAddr(a: string | undefined, b: string | undefined): boolean | null {
  if (!a || !b) return null;
  return stripPort(a) === stripPort(b);
}

export interface ListHeaderFacts {
  present: boolean;
  /** Сколько адресов через запятую. 0 — заголовка нет или он пуст. */
  count: number;
  /** Род каждого элемента по порядку: слева — то, что заявлено как клиент. */
  kinds: AddrKind[];
}

export type ProbeVerdict =
  /** x-real-ip нет: доверенный порядок падает на заголовки, которые пишет клиент. */
  | 'x_real_ip_absent'
  /** Дошёл документационный адрес — прокси пропускает клиентский x-real-ip. */
  | 'x_real_ip_client_controlled'
  /** Внутренний адрес — это хоп платформы, общий для всех: ключом лимита не годится. */
  | 'x_real_ip_internal'
  /** Проба прислала свой, пришёл другой публичный: прокси ставит заголовок сам. */
  | 'x_real_ip_set_by_proxy'
  /** Публичный, но подделку проба не присылала — перезаписал бы её прокси, неизвестно. */
  | 'x_real_ip_unverified'
  /** В заголовке не один публичный адрес, а что-то иное — разбирать глазами. */
  | 'x_real_ip_unexpected';

export interface ClientIpHeadersReport {
  x_real_ip: ListHeaderFacts;
  cf_connecting_ip: ListHeaderFacts;
  x_forwarded_for: ListHeaderFacts;
  forwarded_present: boolean;        // RFC 7239
  x_forwarded_proto_present: boolean;
  x_forwarded_host_present: boolean;
  true_client_ip_present: boolean;
  x_client_ip_present: boolean;
  /** null — одного из двух нет, сравнивать нечего (не «не совпало»). */
  x_real_ip_equals_xff_last: boolean | null;
  x_real_ip_equals_xff_first: boolean | null;
  cf_connecting_ip_equals_xff_first: boolean | null;
  /** Из какого заголовка `getTrustedClientIp` возьмёт адрес на этом запросе. */
  trusted_source: 'x-real-ip' | 'cf-connecting-ip' | 'x-forwarded-for' | 'none';
  /** Проба заявила, что прислала документационные адреса во все три заголовка. */
  forged_sent: boolean;
  verdict: ProbeVerdict;
}

function listFacts(value: string | null): ListHeaderFacts {
  const items = value ? splitList(value) : [];
  return { present: value !== null, count: items.length, kinds: items.map(classifyAddr) };
}

function verdictOf(xri: ListHeaderFacts, forgedSent: boolean): ProbeVerdict {
  if (xri.count === 0) return 'x_real_ip_absent';
  if (xri.kinds.includes('documentation')) return 'x_real_ip_client_controlled';
  if (xri.count !== 1) return 'x_real_ip_unexpected';
  const kind = xri.kinds[0];
  if (kind === 'private' || kind === 'loopback' || kind === 'link_local' || kind === 'cgnat') return 'x_real_ip_internal';
  if (kind !== 'public') return 'x_real_ip_unexpected';
  return forgedSent ? 'x_real_ip_set_by_proxy' : 'x_real_ip_unverified';
}

/**
 * Разбор заголовков одного запроса. Чистая функция: на вход — заголовки, на
 * выход — флаги, числа и роды. Ни одной строки адреса в ответе нет.
 */
export function describeClientIpHeaders(headers: Headers, forgedSent: boolean): ClientIpHeadersReport {
  const xriRaw = headers.get('x-real-ip');
  const cfRaw = headers.get('cf-connecting-ip');
  const xffRaw = headers.get('x-forwarded-for');

  const xri = listFacts(xriRaw);
  const cf = listFacts(cfRaw);
  const xff = listFacts(xffRaw);

  const xriFirst = xriRaw ? splitList(xriRaw)[0] : undefined;
  const cfFirst = cfRaw ? splitList(cfRaw)[0] : undefined;
  const xffItems = xffRaw ? splitList(xffRaw) : [];

  // Тот же порядок, что в getTrustedClientIp (lib/rate-limit.ts): пустой
  // заголовок там пропускается, поэтому и здесь решает непустота.
  const trusted_source = xriRaw?.trim()
    ? 'x-real-ip'
    : cfRaw?.trim()
      ? 'cf-connecting-ip'
      : xffRaw?.split(',')[0]?.trim()
        ? 'x-forwarded-for'
        : 'none';

  return {
    x_real_ip: xri,
    cf_connecting_ip: cf,
    x_forwarded_for: xff,
    forwarded_present: headers.has('forwarded'),
    x_forwarded_proto_present: headers.has('x-forwarded-proto'),
    x_forwarded_host_present: headers.has('x-forwarded-host'),
    true_client_ip_present: headers.has('true-client-ip'),
    x_client_ip_present: headers.has('x-client-ip'),
    x_real_ip_equals_xff_last: sameAddr(xriFirst, xffItems[xffItems.length - 1]),
    x_real_ip_equals_xff_first: sameAddr(xriFirst, xffItems[0]),
    cf_connecting_ip_equals_xff_first: sameAddr(cfFirst, xffItems[0]),
    trusted_source,
    forged_sent: forgedSent,
    verdict: verdictOf(xri, forgedSent),
  };
}

/** Что делать с getClientIp дальше — словами, для человека, читающего ответ. */
export function verdictNote(verdict: ProbeVerdict): string {
  switch (verdict) {
    case 'x_real_ip_absent':
      return 'Прокси x-real-ip не ставит: getTrustedClientIp берёт cf-connecting-ip или первый элемент X-Forwarded-For, а оба пишет клиент. Перевод getClientIp на доверенный порядок против подделки ничего не даст — нужен другой ключ (последний элемент XFF, если его дописывает прокси, или ключ по учётной записи)';
    case 'x_real_ip_client_controlled':
      return 'Документационный адрес дошёл до приложения: прокси пропускает x-real-ip от клиента. Доверять ему нельзя — getTrustedClientIp сейчас подделывается так же, как getClientIp';
    case 'x_real_ip_internal':
      return 'x-real-ip — внутренний адрес: это хоп платформы, общий для всех посетителей. Ключом лимита он склеит всех в одного — переводить на него нельзя';
    case 'x_real_ip_set_by_proxy':
      return 'Проба прислала свой x-real-ip, а пришёл другой публичный: прокси ставит заголовок сам. Доверенный порядок работает — getClientIp можно переводить на getTrustedClientIp (часть 2 P3-02)';
    case 'x_real_ip_unverified':
      return 'x-real-ip публичный, но подделку проба не присылала. Повторить с ?forged=1 и документационными адресами в X-Real-IP, CF-Connecting-IP и X-Forwarded-For';
    case 'x_real_ip_unexpected':
      return 'x-real-ip несёт не один публичный адрес — разобрать по родам в x_real_ip.kinds, прежде чем на него опираться';
  }
}
