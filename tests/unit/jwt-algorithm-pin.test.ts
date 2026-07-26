// @vitest-environment node
/**
 * Пин алгоритма JWT (защита в глубину против algorithm-confusion).
 * verifyToken должен принимать только HS256 и отвергать всё прочее (в т.ч.
 * попытку подсунуть токен без подписи). Пин продублирован в middleware.ts —
 * структурный страж ниже держит оба места в согласии.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createToken, verifyToken } from '@/lib/auth/jwt';

const SECRET = 'test-secret-at-least-32-bytes-long-000';

beforeAll(() => { process.env.JWT_SECRET = SECRET; });

const payload = { userId: 'u1', email: 'a@b.ru', role: 'tourist' };

describe('verifyToken пинит HS256', () => {
  it('валидный HS256-токен принимается', async () => {
    const token = await createToken(payload);
    const out = await verifyToken(token);
    expect(out?.userId).toBe('u1');
  });

  it('токен с alg:none отвергается (null, не бросок)', async () => {
    // Unsecured JWT (alg:none) — классика algorithm-confusion. Пин HS256 обязан
    // его отвергнуть, иначе можно подделать любой токен без подписи.
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ ...payload, exp: Math.floor(Date.now() / 1000) + 3600 })}.`;
    expect(await verifyToken(unsigned)).toBeNull();
  });

  it('битая подпись отвергается', async () => {
    const token = await createToken(payload);
    // Портим последний символ подписи
    const tampered = token.slice(0, -1) + (token.at(-1) === 'A' ? 'B' : 'A');
    expect(await verifyToken(tampered)).toBeNull();
  });
});

describe('структурно: пин алгоритма в обоих местах верификации', () => {
  it('lib/auth/jwt.ts передаёт algorithms в jwtVerify', () => {
    const src = readFileSync('lib/auth/jwt.ts', 'utf8');
    expect(src).toMatch(/algorithms:\s*\[JWT_ALGORITHM\]/);
  });
  it('middleware.ts передаёт algorithms в jwtVerify', () => {
    const src = readFileSync('middleware.ts', 'utf8');
    expect(src).toMatch(/algorithms:\s*\[JWT_ALGORITHM\]/);
  });
});
