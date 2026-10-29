/**
 * Публичный ли адрес и во что разрешается имя — для исходящих запросов на
 * адрес, который выбрал чужой человек (уведомление агенту, 29.10).
 *
 * `isPrivateAddress` из lib/security/site-audit для этого не годится как
 * есть: не знает NAT64, 6to4, Teredo, 198.18/15, документационных сетей, а
 * мапленный IPv4 ловит только в точечной записи, тогда как парсер URL Node
 * даёт `[::ffff:7f00:1]`. Здесь — `net.BlockList`: он сверяет мапленные IPv6
 * (`::ffff:a.b.c.d` и `::ffff:7f00:1`) с правилами IPv4 сам (проверено в
 * Node 22.22). Отдельного правила `::ffff:0:0/96` нет НАМЕРЕННО: BlockList
 * сверяет и обратное — IPv4-адрес с IPv6-правилами через мапленную форму, —
 * и такое правило закрыло бы весь IPv4 (поймано сторожем 29.10).
 *
 * Разрешение имени — `dns.promises.Resolver` (c-ares) с таймаутом и одной
 * попыткой, а не `dns.lookup`: тот идёт через пул потоков libuv (4 потока,
 * общие с fs, crypto и zlib всего сервера) и без таймаута, и хозяин
 * авторитетного DNS своего имени мог бы медленными ответами занять пул
 * прод-процесса (критика безопасности 29.10). /etc/hosts c-ares не читает —
 * и не нужно.
 *
 * Проверка «все адреса публичные» и соединение — один ответ DNS: отправитель
 * отдаёт сокету ровно эти адреса через свой lookup (lib/mcp/notify-send).
 * Смешанный ответ (публичный и внутренний) — отказ целиком: это признак
 * rebinding, а не повод выбрать «хороший».
 */

import { BlockList, isIP } from 'node:net';
import { Resolver } from 'node:dns/promises';

const BLOCKED = new BlockList();

/** IPv4: «этот хост», частные, CGNAT, петля, link-local, служебные, документационные, бенчмарк, мультикаст и резерв. */
const V4: Array<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

/**
 * IPv6: неуказанный и петля, v4-совместимые, NAT64 (оба префикса),
 * служебные (2001::/23 — с Teredo 2001::/32), документационный, 6to4,
 * уникальные локальные, link-local, site-local, мультикаст. Мапленные
 * (::ffff:0:0/96) — правилами IPv4 выше, см. шапку.
 */
const V6: Array<[string, number]> = [
  ['::', 128], ['::1', 128], ['::', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48],
  ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10],
  ['fec0::', 10], ['ff00::', 8],
];

for (const [net, prefix] of V4) BLOCKED.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of V6) BLOCKED.addSubnet(net, prefix, 'ipv6');

/** Адрес публичный: Node знает его как IP, и ни одно правило не совпало. Не IP — не публичный. */
export function isPublicIp(addr: string): boolean {
  const family = isIP(addr);
  if (family === 0) return false;
  return !BLOCKED.check(addr, family === 4 ? 'ipv4' : 'ipv6');
}

export interface ResolvedAddress { address: string; family: 4 | 6 }

export type ResolveOutcome =
  | { ok: true; addresses: ResolvedAddress[] }
  | { ok: false; code: 'dns_timeout' | 'dns_failed' | 'address_refused' };

/** Что нужно от резолвера — в тестах подкладывается свой. */
export interface PublicResolver {
  resolve4(host: string): Promise<string[]>;
  resolve6(host: string): Promise<string[]>;
  cancel?(): void;
}

/** Таймаут одного запроса резолвера, мс; попытка одна. */
export const DNS_TIMEOUT_MS = 2000;

function errCode(r: PromiseRejectedResult): string {
  const code = (r.reason as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : '';
}

/**
 * Разрешить имя и пропустить, только если ВСЕ адреса публичные. Срок общий
 * (`timeoutMs`): по нему резолвер отменяется, исход — dns_timeout. Пусто —
 * dns_failed. Какой именно адрес оказался внутренним, наружу не уходит:
 * исход один — address_refused.
 */
export async function resolvePublic(
  host: string,
  opts: { resolver?: PublicResolver; timeoutMs?: number } = {},
): Promise<ResolveOutcome> {
  const resolver: PublicResolver = opts.resolver ?? new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
  const timeoutMs = Math.max(1, opts.timeoutMs ?? DNS_TIMEOUT_MS + 500);
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs); });
  const both = Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
  const raced = await Promise.race([both, expired]);
  if (timer) clearTimeout(timer);
  if (raced === 'timeout') {
    resolver.cancel?.();
    return { ok: false, code: 'dns_timeout' };
  }
  const [v4, v6] = raced;
  const addresses: ResolvedAddress[] = [
    ...(v4.status === 'fulfilled' ? v4.value.map((address) => ({ address, family: 4 as const })) : []),
    ...(v6.status === 'fulfilled' ? v6.value.map((address) => ({ address, family: 6 as const })) : []),
  ];
  if (addresses.length === 0) {
    const timedOut = [v4, v6].some((r) => r.status === 'rejected' && errCode(r) === 'ETIMEOUT');
    return { ok: false, code: timedOut ? 'dns_timeout' : 'dns_failed' };
  }
  if (!addresses.every((a) => isPublicIp(a.address))) return { ok: false, code: 'address_refused' };
  return { ok: true, addresses };
}
