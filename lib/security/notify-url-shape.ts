/**
 * Форма адреса уведомления агенту (notify_url, 29.10) — чистая проверка, без
 * сети и без node:net: её зовут и Zod-схема пишущих инструментов (до записи
 * заявки), и отправитель перед каждой попыткой (правила могли ужесточиться,
 * а адрес лежит в базе 90 дней).
 *
 * Здесь — только то, что видно по самому адресу. Куда имя разрешается, судит
 * отправитель при каждой отправке (lib/security/public-address): DNS меняется,
 * и приговор при создании устарел бы.
 *
 * Правила и почему:
 * - только https и порт по умолчанию: внутренние службы на публичных адресах
 *   живут на нестандартных портах, а открытый http отдал бы тело и подпись
 *   любому на пути;
 * - без логина и пароля в адресе и без фрагмента (#… на сервер не уходит —
 *   агент ждал бы не того);
 * - не IP-литерал ВОВСЕ: у приёмника есть имя, сертификат выдан имени, а при
 *   литерале Node не зовёт свой lookup — проверку адреса при соединении
 *   литерал обошёл бы. Парсер URL сводит `2130706433`, `0x7f.1`, `127.1` к
 *   точечной записи, а IPv6 оставляет в скобках (`[::ffff:7f00:1]`) — оба
 *   случая ловятся по разобранному имени, со снятыми скобками (критика
 *   безопасности 29.10: `net.isIP('[::1]')` — 0, скобки надо снять);
 * - имя годится для DNS: не длиннее 253 знаков, ни одна часть между точками
 *   не длиннее 63 и не пуста. Парсер URL этого не проверяет, а колонка
 *   url_host — VARCHAR(253): длинное имя проходило проверку, заявка
 *   создавалась, запись подписки падала с 22001, и агент слышал «сбой на
 *   стороне Ведара» вместо «неверный адрес» (ревью 29.10);
 * - имя с точкой, без хвостовой точки, не служебное (localhost, .local,
 *   .internal, .test, .example, .onion, …) и не из RFC 2606 (example.com/net/
 *   org — модели подставляют их в необязательные поля);
 * - не наш хост: vedarai.ru, технический хост Timeweb (isTechnicalHost — то
 *   же приложение под другим именем) и наши реле *.tourhabk.workers.dev —
 *   подписанный POST на свои же API.
 */

import { isTechnicalHost } from '@/lib/config';

export const NOTIFY_URL_MAX_CHARS = 1000;
/** Пределы имени в DNS (RFC 1035 §2.3.4): имя целиком и одна часть между точками. */
export const DNS_NAME_MAX_CHARS = 253;
export const DNS_LABEL_MAX_CHARS = 63;

export type NotifyUrlRefusal =
  | 'too_long' | 'bad_chars' | 'not_url' | 'not_https' | 'port' | 'credentials' | 'fragment'
  | 'ip_literal' | 'trailing_dot' | 'dns_name' | 'single_label' | 'reserved_name' | 'own_host';

export type NotifyUrlShape =
  | { ok: true; url: URL; host: string }
  | { ok: false; code: NotifyUrlRefusal; message: string };

const RESERVED_SUFFIXES = [
  'localhost', 'local', 'internal', 'intranet', 'lan', 'home.arpa', 'arpa', 'corp', 'home',
  'test', 'invalid', 'example', 'onion', 'localdomain',
] as const;

const RFC2606 = ['example.com', 'example.net', 'example.org'] as const;

/** Наши хосты: свой домен и реле на Cloudflare (infra/ai-relay, infra/safety-relay). */
const OWN_DOMAINS = ['vedarai.ru', 'tourhabk.workers.dev'] as const;

const MESSAGES: Record<NotifyUrlRefusal, string> = {
  too_long: `notify_url: адрес длиннее ${NOTIFY_URL_MAX_CHARS} знаков.`,
  bad_chars: 'notify_url: в адресе пробелы или управляющие символы.',
  not_url: 'notify_url: это не адрес — нужен полный адрес приёмника вида https://имя/путь.',
  not_https: 'notify_url: принимается только https.',
  port: 'notify_url: только стандартный порт https (443) — без :порта в адресе.',
  credentials: 'notify_url: без логина и пароля в адресе.',
  fragment: 'notify_url: без фрагмента (#…) — он на сервер не уходит.',
  ip_literal: 'notify_url: нужен адрес с именем хоста, а не IP-адрес.',
  trailing_dot: 'notify_url: имя хоста без точки на конце.',
  dns_name: `notify_url: такое имя хоста DNS не разрешит — оно длиннее ${DNS_NAME_MAX_CHARS} знаков либо часть между точками пуста или длиннее ${DNS_LABEL_MAX_CHARS} знаков.`,
  single_label: 'notify_url: имя хоста без домена (нет точки) — нужен публичный адрес.',
  reserved_name: 'notify_url: служебное или примерное имя (localhost, .local, .internal, example.com…) — нужен настоящий публичный адрес приёмника.',
  own_host: 'notify_url: адрес платформы Ведар не может быть приёмником уведомлений.',
};

function refuse(code: NotifyUrlRefusal): NotifyUrlShape {
  return { ok: false, code, message: MESSAGES[code] };
}

const IPV4_DOTTED = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** IP-литерал в разобранном имени: точечный IPv4 или IPv6 в скобках (скобки снимаются перед проверкой). */
export function isIpLiteralHost(hostname: string): boolean {
  const bare = hostname.replace(/^\[/, '').replace(/\]$/, '');
  return bare !== hostname || bare.includes(':') || IPV4_DOTTED.test(bare);
}

function endsWithDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

export function checkNotifyUrlShape(raw: string): NotifyUrlShape {
  if (raw.length > NOTIFY_URL_MAX_CHARS) return refuse('too_long');
  if (/[\s\p{Cc}]/u.test(raw)) return refuse('bad_chars');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Не разбирается — это и есть ответ: адреса нет.
    return refuse('not_url');
  }
  if (url.protocol !== 'https:') return refuse('not_https');
  if (url.port !== '' && url.port !== '443') return refuse('port');
  if (url.username !== '' || url.password !== '') return refuse('credentials');
  if (url.hash !== '' || raw.includes('#')) return refuse('fragment');
  const host = url.hostname.toLowerCase();
  if (isIpLiteralHost(host)) return refuse('ip_literal');
  if (host.endsWith('.')) return refuse('trailing_dot');
  // Длина — после IDNA (url.hostname уже в punycode): именно её видит DNS.
  if (host.length > DNS_NAME_MAX_CHARS || host.split('.').some((l) => l.length === 0 || l.length > DNS_LABEL_MAX_CHARS)) {
    return refuse('dns_name');
  }
  if (!host.includes('.')) return refuse('single_label');
  if (RESERVED_SUFFIXES.some((s) => endsWithDomain(host, s)) || RFC2606.some((d) => endsWithDomain(host, d))) {
    return refuse('reserved_name');
  }
  if (OWN_DOMAINS.some((d) => endsWithDomain(host, d)) || isTechnicalHost(`https://${host}/`)) return refuse('own_host');
  return { ok: true, url, host };
}
