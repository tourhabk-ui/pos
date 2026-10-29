// @vitest-environment node
/**
 * Защита исходящего POST на адрес, который выбрал чужой человек
 * (уведомление агенту, 29.10): форма адреса, публичность IP, разрешение
 * имени и сама отправка.
 *
 * Держит обходы из критики безопасности 29.10:
 * - IPv6-литерал в скобках (`net.isIP('[::1]')` — 0) отвергается СВОИМ кодом
 *   ip_literal, а не побочно правилом «нет точки»; литерал не доходит до
 *   https.request вовсе (при литерале Node не зовёт lookup);
 * - мапленный IPv4 в обеих записях, NAT64, 6to4, Teredo, 198.18/15 —
 *   непубличные; смешанный ответ DNS — отказ целиком;
 * - технический хост Timeweb и наши реле — «свой хост»;
 * - один абсолютный срок на попытку: сервер, присылающий по байту, и
 *   резолвер, который молчит, укладываются в срок;
 * - редиректам не следуем; исход — машинный код без хоста.
 */
import { describe, it, expect, vi } from 'vitest';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { checkNotifyUrlShape, isIpLiteralHost } from '@/lib/security/notify-url-shape';
import { isPublicIp, resolvePublic, type PublicResolver } from '@/lib/security/public-address';
import { postSigned, pinnedLookup, outcomeOfStatus, networkCode } from '@/lib/mcp/notify-send';

describe('форма адреса', () => {
  const cases: Array<[string, string]> = [
    ['http://hooks.example-agent.ru/x', 'not_https'],
    ['https://hooks.example-agent.ru:8443/x', 'port'],
    ['https://user:pass@hooks.example-agent.ru/', 'credentials'],
    ['https://hooks.example-agent.ru/x#frag', 'fragment'],
    ['https://2130706433/', 'ip_literal'],
    ['https://0x7f.1/', 'ip_literal'],
    ['https://127.1/', 'ip_literal'],
    ['https://127.0.0.1/', 'ip_literal'],
    ['https://[::1]/', 'ip_literal'],
    ['https://[::ffff:127.0.0.1]/', 'ip_literal'],
    ['https://[::ffff:7f00:1]/', 'ip_literal'],
    ['https://[::ffff:a9fe:a9fe]/', 'ip_literal'],
    ['https://hooks.example-agent.ru./x', 'trailing_dot'],
    ['https://hooks/x', 'single_label'],
    ['https://localhost/x', 'single_label'],
    ['https://a.localhost/x', 'reserved_name'],
    ['https://printer.local/x', 'reserved_name'],
    ['https://db.internal/x', 'reserved_name'],
    ['https://x.home.arpa/x', 'reserved_name'],
    ['https://example.com/x', 'reserved_name'],
    ['https://hooks.example.org/x', 'reserved_name'],
    ['https://a.b.test/x', 'reserved_name'],
    ['https://vedarai.ru/api/mcp', 'own_host'],
    ['https://api.vedarai.ru/x', 'own_host'],
    ['https://pospkam-pospktry-c1f3.twc1.net/api/mcp', 'own_host'],
    ['https://vedar-ai-relay.tourhabk.workers.dev/anthropic', 'own_host'],
    ['https://hooks.example-agent.ru/a b', 'bad_chars'],
    ['notaurl', 'not_url'],
    [`https://hooks.example-agent.ru/${'a'.repeat(1000)}`, 'too_long'],
  ];
  it.each(cases)('%s → %s', (url, code) => {
    const r = checkNotifyUrlShape(url);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe(code);
      expect(r.message).toMatch(/^notify_url: /);
    }
  });

  it('годный адрес: имя хоста, порт 443 явно или по умолчанию, путь и query сохраняются', () => {
    for (const url of ['https://hooks.example-agent.ru/in?sig=1', 'https://HOOKS.Example-Agent.ru:443/in']) {
      const r = checkNotifyUrlShape(url);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.host).toBe('hooks.example-agent.ru');
    }
  });

  it('IP-литерал узнаётся и в скобках, и точечным — по разобранному имени', () => {
    expect(isIpLiteralHost('[::1]')).toBe(true);
    expect(isIpLiteralHost('[::ffff:7f00:1]')).toBe(true);
    expect(isIpLiteralHost('127.0.0.1')).toBe(true);
    expect(isIpLiteralHost('hooks.example-agent.ru')).toBe(false);
    expect(isIpLiteralHost('1.2.3.4.nip.io')).toBe(false);
  });
});

describe('публичный ли адрес', () => {
  const blocked = [
    '0.0.0.0', '0.255.255.255', '10.0.0.0', '10.255.255.255', '100.64.0.0', '100.127.255.255', '127.0.0.1', '127.255.255.255',
    '169.254.0.0', '169.254.169.254', '169.254.255.255', '172.16.0.0', '172.31.255.255', '192.0.0.0', '192.0.0.255',
    '192.0.2.0', '192.0.2.255', '192.88.99.0', '192.88.99.255', '192.168.0.0', '192.168.255.255', '198.18.0.0', '198.19.255.255',
    '198.51.100.0', '198.51.100.255', '203.0.113.0', '203.0.113.255', '224.0.0.0', '239.255.255.255', '240.0.0.0', '255.255.255.255',
    '::', '::1', '::7f00:1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:10.0.0.1', '::ffff:c0a8:1',
    '64:ff9b::7f00:1', '64:ff9b::808:808', '64:ff9b:1::1', '100::1', '2001::1', '2001:0:4136:e378::1', '2001:1ff:ffff::1',
    '2001:db8::1', '2002:7f00:1::1', '2002:808:808::1', 'fc00::1', 'fdff:ffff::1', 'fe80::1', 'febf::1', 'fec0::1', 'feff::1', 'ff02::1',
  ];
  const open = [
    '1.0.0.0', '8.8.8.8', '11.0.0.0', '93.184.216.34', '100.63.255.255', '100.128.0.0', '128.0.0.0', '169.253.255.255', '169.255.0.0',
    '172.15.255.255', '172.32.0.0', '192.0.1.0', '192.0.3.0', '192.88.98.255', '192.169.0.0', '198.17.255.255', '198.20.0.0',
    '2606:4700:4700::1111', '2a00:1450:4001::1', '2001:200::1',
    // Мапленный публичный — тот же публичный IPv4: соединение уйдёт ровно туда.
    '::ffff:8.8.8.8', '::ffff:808:808',
  ];
  it.each(blocked)('%s — непубличный', (a) => expect(isPublicIp(a)).toBe(false));
  it.each(open)('%s — публичный', (a) => expect(isPublicIp(a)).toBe(true));
  it('не IP — не публичный', () => {
    expect(isPublicIp('hooks.example-agent.ru')).toBe(false);
    expect(isPublicIp('')).toBe(false);
  });
});

function resolver(v4: string[] | Error, v6: string[] | Error, delayMs = 0): PublicResolver & { cancel: ReturnType<typeof vi.fn> } {
  const answer = (r: string[] | Error) => new Promise<string[]>((res, rej) => setTimeout(() => (r instanceof Error ? rej(r) : res(r)), delayMs));
  return { resolve4: () => answer(v4), resolve6: () => answer(v6), cancel: vi.fn() };
}
const dnsErr = (code: string) => Object.assign(new Error(code), { code });

describe('разрешение имени', () => {
  it('публичный A без AAAA — годится', async () => {
    expect(await resolvePublic('h.example-agent.ru', { resolver: resolver(['93.184.216.34'], dnsErr('ENODATA')) }))
      .toEqual({ ok: true, addresses: [{ address: '93.184.216.34', family: 4 }] });
  });

  it('смешанный ответ — публичный и внутренний — отказ целиком (rebinding)', async () => {
    expect(await resolvePublic('h.example-agent.ru', { resolver: resolver(['93.184.216.34'], ['fe80::1']) })).toEqual({ ok: false, code: 'address_refused' });
    expect(await resolvePublic('h.example-agent.ru', { resolver: resolver(['10.0.0.1'], dnsErr('ENODATA')) })).toEqual({ ok: false, code: 'address_refused' });
  });

  it('нет записей — dns_failed; таймаут резолвера — dns_timeout', async () => {
    expect(await resolvePublic('h.example-agent.ru', { resolver: resolver(dnsErr('ENOTFOUND'), dnsErr('ENOTFOUND')) })).toEqual({ ok: false, code: 'dns_failed' });
    expect(await resolvePublic('h.example-agent.ru', { resolver: resolver([], []) })).toEqual({ ok: false, code: 'dns_failed' });
    expect(await resolvePublic('h.example-agent.ru', { resolver: resolver(dnsErr('ETIMEOUT'), dnsErr('ENODATA')) })).toEqual({ ok: false, code: 'dns_timeout' });
  });

  it('резолвер молчит — срок общий, резолвер отменяется', async () => {
    const r = resolver(['93.184.216.34'], [], 5_000);
    const t0 = Date.now();
    expect(await resolvePublic('h.example-agent.ru', { resolver: r, timeoutMs: 80 })).toEqual({ ok: false, code: 'dns_timeout' });
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(r.cancel).toHaveBeenCalled();
  });
});

/** Подложенный https.request: запоминает опции и отвечает статусом или ошибкой. */
function fakeRequest(reply: { status?: number; error?: NodeJS.ErrnoException; hang?: boolean }) {
  const calls: RequestOptions[] = [];
  const fn = (options: RequestOptions, cb: (res: IncomingMessage) => void): ClientRequest => {
    calls.push(options);
    const req = new EventEmitter() as unknown as ClientRequest & { destroyed: boolean };
    let body = '';
    Object.assign(req, {
      end: (chunk?: string) => {
        body += chunk ?? '';
        setTimeout(() => {
          if (reply.hang) return;
          if (reply.error) { req.emit('error', reply.error); return; }
          const res = Object.assign(new EventEmitter(), { statusCode: reply.status, destroy: vi.fn() }) as unknown as IncomingMessage;
          cb(res);
        }, 5);
        return req;
      },
      destroy: vi.fn(() => { req.destroyed = true; return req; }),
      body: () => body,
    });
    return req;
  };
  return { fn, calls };
}

const GOOD = 'https://hooks.example-agent.ru/in?sig=abc';
const PUBLIC = () => resolver(['93.184.216.34'], dnsErr('ENODATA'));

describe('отправка', () => {
  it('IP-литерал и непригодная форма — до https.request не доходит', async () => {
    for (const url of ['https://[::1]/x', 'https://[::ffff:7f00:1]/x', 'https://127.0.0.1/x', 'https://2130706433/x', 'https://localhost/x']) {
      const { fn, calls } = fakeRequest({ status: 200 });
      expect(await postSigned(url, '{}', {}, { request: fn, resolver: PUBLIC() })).toEqual({ kind: 'retry', code: 'address_refused', network: true });
      expect(calls).toHaveLength(0);
    }
  });

  it('имя разрешилось во внутренний адрес — запроса нет, исход address_refused без адреса', async () => {
    const { fn, calls } = fakeRequest({ status: 200 });
    const o = await postSigned(GOOD, '{}', {}, { request: fn, resolver: resolver(['169.254.169.254'], dnsErr('ENODATA')) });
    expect(o).toEqual({ kind: 'retry', code: 'address_refused', network: true });
    expect(JSON.stringify(o)).not.toMatch(/169\.254|hooks/);
    expect(calls).toHaveLength(0);
  });

  it('опции запроса: имя, порт 443, путь с query, проверка TLS явно, без пула; lookup отдаёт только проверенные адреса', async () => {
    const { fn, calls } = fakeRequest({ status: 204 });
    expect(await postSigned(GOOD, '{"a":1}', { 'webhook-id': 'evt_x' }, { request: fn, resolver: PUBLIC() })).toEqual({ kind: 'delivered', code: 'http_204' });
    const o = calls[0]!;
    expect(o).toMatchObject({ method: 'POST', host: 'hooks.example-agent.ru', servername: 'hooks.example-agent.ru', port: 443, path: '/in?sig=abc', agent: false, rejectUnauthorized: true });
    expect(o.headers).toMatchObject({ 'webhook-id': 'evt_x', 'content-length': '7' });
    const lookup = o.lookup as unknown as (h: string, opt: { all?: boolean }, cb: (...a: unknown[]) => void) => void;
    const all = vi.fn();
    lookup('hooks.example-agent.ru', { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [{ address: '93.184.216.34', family: 4 }]);
    const other = vi.fn();
    lookup('evil.example-agent.ru', { all: true }, other);
    expect(other.mock.calls[0][0]).toMatchObject({ code: 'ENOTPUBLIC' });
  });

  it('pinnedLookup без all — первый проверенный адрес', () => {
    const cb = vi.fn();
    pinnedLookup('h.x.ru', [{ address: '93.184.216.34', family: 4 }])('h.x.ru', {}, cb);
    expect(cb).toHaveBeenCalledWith(null, '93.184.216.34', 4);
  });

  it('редиректу не следуем: 302 — повтор с кодом, запрос один', async () => {
    const { fn, calls } = fakeRequest({ status: 302 });
    expect(await postSigned(GOOD, '{}', {}, { request: fn, resolver: PUBLIC() })).toEqual({ kind: 'retry', code: 'redirect_302', network: false });
    expect(calls).toHaveLength(1);
  });

  it('сетевая ошибка с хостом в тексте — исход кодом, без хоста', async () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 93.184.216.34:443 hooks.example-agent.ru'), { code: 'ECONNREFUSED' });
    const { fn } = fakeRequest({ error: err });
    const o = await postSigned(GOOD, '{}', {}, { request: fn, resolver: PUBLIC() });
    expect(o).toEqual({ kind: 'retry', code: 'refused', network: true });
  });

  it('коды статусов: 2xx доставлено, 410 — gone, 4xx — rejected, кроме 408/425/429; 5xx — повтор', () => {
    expect(outcomeOfStatus(200).kind).toBe('delivered');
    expect(outcomeOfStatus(410)).toEqual({ kind: 'gone', code: 'http_410' });
    for (const s of [400, 401, 403, 404, 405, 422]) expect(outcomeOfStatus(s), String(s)).toEqual({ kind: 'rejected', code: `http_${s}` });
    for (const s of [408, 425, 429, 500, 503]) expect(outcomeOfStatus(s), String(s)).toEqual({ kind: 'retry', code: `http_${s}`, network: false });
    expect(networkCode({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' })).toBe('tls');
    expect(networkCode({ code: 'CERT_HAS_EXPIRED' })).toBe('tls');
    expect(networkCode({ code: 'ECONNRESET' })).toBe('reset');
    expect(networkCode({ code: 'VEDAR_DEADLINE' })).toBe('timeout');
    expect(networkCode(new Error('x'))).toBe('network');
  });

  it('резолвер молчит — попытка укладывается в общий срок, исход dns_timeout', async () => {
    const { fn, calls } = fakeRequest({ status: 200 });
    const t0 = Date.now();
    expect(await postSigned(GOOD, '{}', {}, { request: fn, resolver: resolver(['93.184.216.34'], [], 5_000), totalMs: 150 }))
      .toEqual({ kind: 'retry', code: 'dns_timeout', network: true });
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(calls).toHaveLength(0);
  });

  it('сервер шлёт заголовки по байту — абсолютный срок обрывает попытку (настоящий сокет)', async () => {
    const server: Server = createServer();
    const timers: NodeJS.Timeout[] = [];
    server.on('connection', (sock) => {
      const bytes = 'HTTP/1.1 200 OK\r\nX-Slow: ' + 'a'.repeat(100);
      let i = 0;
      const t = setInterval(() => { if (i < bytes.length && !sock.destroyed) sock.write(bytes[i++]); }, 100);
      timers.push(t);
      sock.on('close', () => clearInterval(t));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    // Подложенный request ходит по http на локальный порт — проверяется срок, а не TLS.
    const viaLocal = (options: RequestOptions, cb: (res: IncomingMessage) => void) =>
      httpRequest({ method: options.method, path: options.path, headers: options.headers, host: '127.0.0.1', port, agent: false }, cb);
    const t0 = Date.now();
    const o = await postSigned(GOOD, '{}', {}, { request: viaLocal, resolver: PUBLIC(), totalMs: 700 });
    const elapsed = Date.now() - t0;
    timers.forEach(clearInterval);
    await new Promise<void>((r) => server.close(() => r()));
    server.closeAllConnections?.();
    expect(o).toEqual({ kind: 'retry', code: 'timeout', network: true });
    expect(elapsed).toBeLessThan(1_500);
  });
});
