/**
 * Адрес клиента — только тот, что поставил прокси (21.11).
 *
 * Замер на проде (client-ip-headers-probe, прогон с подделкой): Caddy перед
 * контейнером перезаписывает X-Forwarded-For настоящим адресом, а X-Real-IP
 * и CF-Connecting-IP пропускает от клиента. Приложение доверяло x-real-ip
 * первым — лимиты входа, MFA и чата Кузьмича обходились одним заголовком.
 * Теперь start.js стирает присланные заголовки адреса и ставит X-Real-IP и
 * X-Forwarded-For одним значением — правым элементом XFF или адресом сокета.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { getClientIp, getTrustedClientIp, getTrustedClientIpOrNull, lastForwardedFor } from '@/lib/rate-limit';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const src = read('start.js');
const block = src.match(/\/\/ <clientAddress>([\s\S]*?)\/\/ <\/clientAddress>/);
type Hdrs = Record<string, string | string[] | undefined>;
const clientAddressHeaders = new Function(`${block?.[1] ?? ''}; return clientAddressHeaders;`)() as
  (h: Hdrs, remote?: string) => Hdrs;

describe('start.js: заголовки адреса от клиента не доходят до Next', () => {
  it('блок найден и вызывается в прокси', () => {
    expect(block).not.toBeNull();
    expect(src).toMatch(/\.\.\.clientAddressHeaders\(req\.headers, req\.socket\.remoteAddress\)/);
    // Старой передачи присланного XFF как есть больше нет.
    expect(src).not.toMatch(/'x-forwarded-for':\s*req\.headers\['x-forwarded-for'\]/);
  });

  it('подделка как в пробе: X-Real-IP и CF-Connecting-IP стёрты, адрес — от прокси (правый элемент XFF)', () => {
    const out = clientAddressHeaders({
      'x-real-ip': '198.51.100.7', 'cf-connecting-ip': '198.51.100.8', 'true-client-ip': '198.51.100.10',
      'x-client-ip': '198.51.100.11', forwarded: 'for=198.51.100.12',
      'x-forwarded-for': '198.51.100.9, 95.31.0.1', accept: 'text/html',
    }, '10.0.0.5');
    expect(out['x-real-ip']).toBe('95.31.0.1');
    expect(out['x-forwarded-for']).toBe('95.31.0.1');
    expect(out['cf-connecting-ip']).toBeUndefined();
    expect(out['true-client-ip']).toBeUndefined();
    expect(out['x-client-ip']).toBeUndefined();
    expect(out.forwarded).toBeUndefined();
    expect(out.accept).toBe('text/html');
  });

  it('XFF нет — адрес сокета', () => {
    const out = clientAddressHeaders({ 'x-real-ip': '198.51.100.7' }, '95.31.0.2');
    expect(out['x-real-ip']).toBe('95.31.0.2');
    expect(out['x-forwarded-for']).toBe('95.31.0.2');
  });

  it('ни XFF, ни сокета — 127.0.0.1, не пусто', () => {
    expect(clientAddressHeaders({}, undefined)['x-real-ip']).toBe('127.0.0.1');
  });

  it('XFF массивом (повтор заголовка) — правый элемент последнего', () => {
    expect(clientAddressHeaders({ 'x-forwarded-for': ['1.1.1.1', '2.2.2.2, 95.31.0.3'] }, '10.0.0.1')['x-real-ip']).toBe('95.31.0.3');
  });
});

describe('lib/rate-limit: доверенный порядок', () => {
  it('x-real-ip (его ставит start.js) первым', () => {
    expect(getTrustedClientIp(new Headers({ 'x-real-ip': '95.31.0.1', 'x-forwarded-for': '1.1.1.1' }))).toBe('95.31.0.1');
  });

  it('без x-real-ip — ПРАВЫЙ элемент XFF, а не левый (левый пишет клиент)', () => {
    expect(getTrustedClientIp(new Headers({ 'x-forwarded-for': '198.51.100.9, 95.31.0.1' }))).toBe('95.31.0.1');
  });

  it('CF-Connecting-IP не читается вовсе (Cloudflare перед Ведаром нет)', () => {
    expect(getTrustedClientIpOrNull(new Headers({ 'cf-connecting-ip': '198.51.100.8' }))).toBeNull();
  });

  it('старое имя getClientIp — тот же доверенный порядок', () => {
    const h = new Headers({ 'x-forwarded-for': '198.51.100.9, 95.31.0.1' });
    expect(getClientIp(h)).toBe('95.31.0.1');
    expect(getClientIp(new Headers())).toBe('127.0.0.1');
  });

  it('lastForwardedFor: пустые элементы пропускаются', () => {
    expect(lastForwardedFor(' , 9.9.9.9 , ')).toBe('9.9.9.9');
    expect(lastForwardedFor('')).toBeNull();
    expect(lastForwardedFor(null)).toBeNull();
  });

  it('middleware (Edge-лимит) берёт адрес тем же путём, без cf-connecting-ip', () => {
    const mw = read('middleware.ts');
    expect(mw).toMatch(/getTrustedClientIp\(request\.headers\)/);
    expect(mw).not.toMatch(/headers\.get\('cf-connecting-ip'\)/);
  });

  it('вход и MFA продолжают брать адрес через lib/rate-limit (лимиты не сломаны)', () => {
    for (const f of ['app/api/auth/mfa/verify/route.ts', 'app/api/auth/mfa/login-verify/route.ts']) {
      expect(read(f), f).toMatch(/from '@\/lib\/rate-limit'/);
    }
  });
});
