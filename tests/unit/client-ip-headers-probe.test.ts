/**
 * Проба заголовков адреса клиента (P3-02 аудита 15.10).
 *
 * Перевод 58 роутов с `getClientIp` на доверенный порядок ждёт ответа на
 * вопрос «ставит ли прокси Timeweb x-real-ip и перезаписывает ли
 * клиентский». Проба отвечает на него с прода — и при этом не имеет права
 * отдать сам адрес: адрес посетителя — ПД, адрес раннера — лишнее в логе.
 *
 * Сторож судит вызовом роута:
 *  - ни одно значение адреса, пришедшее в заголовках, в ответ не попадает;
 *  - флаги, числа и роды сходятся с тем, что пришло;
 *  - вердикт различает «нет заголовка», «пропускает клиентское»,
 *    «внутренний хоп», «ставит сам» и «не проверено» — третий исход не
 *    сливается с первым (§4.0).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/cron/client-ip-headers-probe/route';
import { classifyAddr, describeClientIpHeaders } from '@/lib/security/client-ip-headers';
import { getTrustedClientIpOrNull } from '@/lib/rate-limit';

const SECRET = 'probe-test-secret';

beforeAll(() => {
  process.env.CRON_SECRET = SECRET;
});

function probe(headers: Record<string, string>, query = '', auth = true): Promise<Response> {
  const h: Record<string, string> = { ...headers };
  if (auth) h.authorization = `Bearer ${SECRET}`;
  return GET(new NextRequest(`https://vedarai.ru/api/cron/client-ip-headers-probe${query}`, { headers: h }));
}

interface Report {
  x_real_ip: { present: boolean; count: number; kinds: string[] };
  cf_connecting_ip: { present: boolean; count: number; kinds: string[] };
  x_forwarded_for: { present: boolean; count: number; kinds: string[] };
  x_forwarded_proto_present: boolean;
  x_forwarded_host_present: boolean;
  x_real_ip_equals_xff_last: boolean | null;
  x_real_ip_equals_xff_first: boolean | null;
  cf_connecting_ip_equals_xff_first: boolean | null;
  trusted_source: string;
  forged_sent: boolean;
  verdict: string;
  note: string;
}

const DOTTED_QUAD = /\b\d{1,3}(?:\.\d{1,3}){3}\b/;

/** Ответ не несёт ни одного из значений, пришедших в заголовках. */
async function readClean(res: Response, sent: string[]): Promise<Report> {
  const text = await res.text();
  for (const value of sent) {
    for (const part of value.split(',').map((x) => x.trim()).filter(Boolean)) {
      expect(text, `значение заголовка «${part}» утекло в ответ`).not.toContain(part);
    }
  }
  expect(text, 'в ответе строка, похожая на IPv4').not.toMatch(DOTTED_QUAD);
  return JSON.parse(text) as Report;
}

describe('проба заголовков адреса: доступ', () => {
  it('без CRON_SECRET — 401', async () => {
    const res = await probe({ 'x-real-ip': '8.8.8.8' }, '', false);
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('8.8.8.8');
  });

  it('forged принимает только 0 или 1', async () => {
    const res = await probe({}, '?forged=yes');
    expect(res.status).toBe(400);
  });
});

describe('проба заголовков адреса: только флаги, числа и роды', () => {
  it('прокси ставит x-real-ip сам и дописывает себя в конец XFF', async () => {
    const sent = {
      'x-real-ip': '8.8.8.8',
      'x-forwarded-for': '198.51.100.9, 8.8.8.8',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'vedarai.ru',
    };
    const res = await probe(sent, '?forged=1');
    expect(res.status).toBe(200);
    const r = await readClean(res, [sent['x-real-ip'], sent['x-forwarded-for']]);

    expect(r.x_real_ip).toEqual({ present: true, count: 1, kinds: ['public'] });
    expect(r.x_forwarded_for).toEqual({ present: true, count: 2, kinds: ['documentation', 'public'] });
    expect(r.cf_connecting_ip).toEqual({ present: false, count: 0, kinds: [] });
    expect(r.x_forwarded_proto_present).toBe(true);
    expect(r.x_forwarded_host_present).toBe(true);
    expect(r.x_real_ip_equals_xff_last).toBe(true);
    expect(r.x_real_ip_equals_xff_first).toBe(false);
    expect(r.cf_connecting_ip_equals_xff_first).toBeNull();
    expect(r.trusted_source).toBe('x-real-ip');
    expect(r.forged_sent).toBe(true);
    expect(r.verdict).toBe('x_real_ip_set_by_proxy');
  });

  it('документационный x-real-ip дошёл — прокси пропускает клиентское', async () => {
    const sent = {
      'x-real-ip': '198.51.100.7',
      'cf-connecting-ip': '198.51.100.8',
      'x-forwarded-for': '198.51.100.9',
    };
    const r = await readClean(await probe(sent, '?forged=1'), Object.values(sent));
    expect(r.verdict).toBe('x_real_ip_client_controlled');
    expect(r.cf_connecting_ip.kinds).toEqual(['documentation']);
    expect(r.x_real_ip_equals_xff_first).toBe(false);
  });

  it('x-real-ip нет — доверенный порядок падает на XFF, вердикт «нет заголовка»', async () => {
    const sent = { 'x-forwarded-for': '203.0.113.4, 10.0.0.12' };
    const r = await readClean(await probe(sent, '?forged=1'), Object.values(sent));
    expect(r.x_real_ip).toEqual({ present: false, count: 0, kinds: [] });
    expect(r.x_forwarded_for.kinds).toEqual(['documentation', 'private']);
    expect(r.x_real_ip_equals_xff_last).toBeNull();
    expect(r.x_real_ip_equals_xff_first).toBeNull();
    expect(r.trusted_source).toBe('x-forwarded-for');
    expect(r.verdict).toBe('x_real_ip_absent');
  });

  it('внутренний x-real-ip — хоп платформы, ключом лимита не годится', async () => {
    const sent = { 'x-real-ip': '10.20.30.40', 'x-forwarded-for': '5.6.7.8, 10.20.30.40' };
    const r = await readClean(await probe(sent), Object.values(sent));
    expect(r.verdict).toBe('x_real_ip_internal');
    expect(r.x_real_ip_equals_xff_last).toBe(true);
  });

  it('публичный x-real-ip без подделки — «не проверено», а не «ставит сам»', async () => {
    const sent = { 'x-real-ip': '2a00:1450:4010:c05::8a' };
    const r = await readClean(await probe(sent), Object.values(sent));
    expect(r.x_real_ip.kinds).toEqual(['public']);
    expect(r.forged_sent).toBe(false);
    expect(r.verdict).toBe('x_real_ip_unverified');
  });

  it('заголовков адреса нет вовсе', async () => {
    const r = await readClean(await probe({}), []);
    expect(r.trusted_source).toBe('none');
    expect(r.verdict).toBe('x_real_ip_absent');
    expect(r.x_forwarded_for.count).toBe(0);
  });
});

describe('род адреса', () => {
  it.each([
    ['8.8.8.8', 'public'],
    ['1.2.3.4:5678', 'public'],
    ['10.0.0.1', 'private'],
    ['172.16.5.4', 'private'],
    ['192.168.1.1', 'private'],
    ['127.0.0.1', 'loopback'],
    ['100.64.1.1', 'cgnat'],
    ['169.254.169.254', 'link_local'],
    ['192.0.2.1', 'documentation'],
    ['198.51.100.200', 'documentation'],
    ['203.0.113.9', 'documentation'],
    ['0.0.0.0', 'reserved'],
    ['300.1.1.1', 'not_an_ip'],
    ['unknown', 'not_an_ip'],
    ['::1', 'loopback'],
    ['[2001:db8::1]:443', 'documentation'],
    ['fd00::1', 'private'],
    ['fe80::1', 'link_local'],
    ['::ffff:10.0.0.1', 'private'],
    ['2a00:1450:4010:c05::8a', 'public'],
  ])('%s → %s', (raw, kind) => {
    expect(classifyAddr(raw)).toBe(kind);
  });
});

describe('проба называет тот же заголовок, из которого возьмёт адрес getTrustedClientIp', () => {
  it.each<[string, Record<string, string>]>([
    ['все три', { 'x-real-ip': '8.8.8.8', 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '9.9.9.9' }],
    ['пустой x-real-ip', { 'x-real-ip': '  ', 'cf-connecting-ip': '1.1.1.1' }],
    ['только XFF', { 'x-forwarded-for': '9.9.9.9, 10.0.0.1' }],
    ['XFF с пустым первым элементом', { 'x-forwarded-for': ' , 9.9.9.9' }],
    ['ничего', {}],
  ])('%s', (_name, raw) => {
    const headers = new Headers(raw);
    const { trusted_source } = describeClientIpHeaders(headers, false);
    const ip = getTrustedClientIpOrNull(headers);
    if (trusted_source === 'none') {
      expect(ip).toBeNull();
    } else {
      expect(headers.get(trusted_source)?.split(',')[0]?.trim()).toBe(ip);
    }
  });
});
