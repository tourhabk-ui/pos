/**
 * Ссылка входа из Telegram /login (22.11): 5 минут, один раз, не для admin
 * и не для учётных записей с двухфакторной проверкой.
 */
import { describe, it, expect } from 'vitest';
import { SignJWT } from 'jose';
import {
  MAGIC_LINK_TTL_SEC, magicLinkAllowed, readMagicToken, redeemMagicJti, signMagicToken,
} from '@/lib/auth/magic-link';

const env = { JWT_SECRET: 'test-secret-for-magic-link' } as unknown as NodeJS.ProcessEnv;
const USER = '11111111-2222-4333-8444-555555555555';

/** Таблица погашений в памяти — та же семантика, что INSERT … ON CONFLICT DO NOTHING RETURNING. */
function fakeDb() {
  const used = new Set<string>();
  return {
    used,
    async query(text: string, params?: unknown[]) {
      if (text.includes('INSERT INTO magic_link_redemptions')) {
        const jti = String(params?.[0]);
        if (used.has(jti)) return { rows: [] };
        used.add(jti);
        return { rows: [{ jti }] };
      }
      return { rows: [] };
    },
  };
}

describe('magic link: роль', () => {
  it('admin — нет', () => expect(magicLinkAllowed({ role: 'admin' })).toBe(false));
  it('двухфакторная проверка включена — нет', () => expect(magicLinkAllowed({ role: 'tourist', mfa_enabled: true })).toBe(false));
  it('турист, оператор, гид — да', () => {
    for (const role of ['tourist', 'operator', 'guide']) expect(magicLinkAllowed({ role, mfa_enabled: false })).toBe(true);
  });
});

describe('magic link: токен', () => {
  it('срок — 5 минут', () => expect(MAGIC_LINK_TTL_SEC).toBe(300));

  it('подписанный токен читается, у него есть jti', async () => {
    const t = await signMagicToken(USER, env);
    const r = await readMagicToken(t, env);
    expect(r?.userId).toBe(USER);
    expect(r?.jti).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('у двух ссылок разные jti', async () => {
    const a = await readMagicToken(await signMagicToken(USER, env), env);
    const b = await readMagicToken(await signMagicToken(USER, env), env);
    expect(a?.jti).not.toBe(b?.jti);
  });

  it('токен старого вида без jti — отказ', async () => {
    const old = await new SignJWT({ userId: USER })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('15m')
      .sign(new TextEncoder().encode('magic:' + env.JWT_SECRET));
    expect(await readMagicToken(old, env)).toBeNull();
  });

  it('просроченный токен — отказ', async () => {
    const past = Math.floor(Date.now() / 1000) - 600;
    const t = await new SignJWT({ userId: USER })
      .setProtectedHeader({ alg: 'HS256' }).setJti('11111111-2222-4333-8444-555555555556')
      .setIssuedAt(past).setExpirationTime(past + 60)
      .sign(new TextEncoder().encode('magic:' + env.JWT_SECRET));
    expect(await readMagicToken(t, env)).toBeNull();
  });

  it('чужая подпись — отказ', async () => {
    const t = await signMagicToken(USER, { JWT_SECRET: 'other' } as unknown as NodeJS.ProcessEnv);
    expect(await readMagicToken(t, env)).toBeNull();
  });
});

describe('magic link: один раз', () => {
  it('первое погашение — да, повтор той же ссылки — нет', async () => {
    const db = fakeDb();
    const r = await readMagicToken(await signMagicToken(USER, env), env);
    expect(await redeemMagicJti(db, r!.jti, USER)).toBe(true);
    expect(await redeemMagicJti(db, r!.jti, USER)).toBe(false);
  });

  it('два одновременных входа по одной ссылке — проходит ровно один', async () => {
    const db = fakeDb();
    const r = await readMagicToken(await signMagicToken(USER, env), env);
    const out = await Promise.all([redeemMagicJti(db, r!.jti, USER), redeemMagicJti(db, r!.jti, USER)]);
    expect(out.filter(Boolean)).toHaveLength(1);
  });

  it('погашение — одной вставкой с ON CONFLICT DO NOTHING', async () => {
    const seen: string[] = [];
    await redeemMagicJti({ query: async (t: string) => { seen.push(t); return { rows: [] }; } }, 'x', USER);
    expect(seen[0]).toMatch(/INSERT INTO magic_link_redemptions[\s\S]*ON CONFLICT \(jti\) DO NOTHING[\s\S]*RETURNING/);
  });
});
