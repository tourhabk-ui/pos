/**
 * Эко за отзыв следуют за видимостью (решение владельца 24.09: «списывай при
 * скрытии»). Сведение к цели: скрыли — ноль, вернули — сколько положено;
 * повторы не списывают дважды; потраченное называется недостачей.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Журнал в памяти: проводки и балансы.
type Entry = { debitAccount: string; creditAccount: string; amount: number; operation: string; source: string; sourceRef: string | null };
let journal: Entry[] = [];
let balances: Record<string, number> = {};

vi.mock('@/lib/database', () => ({
  query: async (sql: string, params: unknown[]) => {
    if (sql.includes('FROM eco_ledger')) {
      const [account, exact, likePrefix] = params as [string, string, string];
      const prefix = likePrefix.replace(/%$/, '');
      const rel = journal.filter(e => (e.creditAccount === account || e.debitAccount === account)
        && (e.sourceRef === exact || (e.sourceRef ?? '').startsWith(prefix)));
      const held = rel.reduce((s, e) => s + (e.creditAccount === account ? e.amount : 0) - (e.debitAccount === account ? e.amount : 0), 0);
      const emitted = rel.filter(e => e.sourceRef === exact && e.operation === 'emit').length;
      return { rows: [{ held: String(held), emitted: String(emitted) }] };
    }
    if (sql.includes('FROM eco_balances')) {
      return { rows: [{ balance: String(balances[params[0] as string] ?? 0) }] };
    }
    throw new Error('unexpected SQL ' + sql);
  },
}));

vi.mock('@/lib/eco/ledger', () => ({
  SYSTEM_ACCOUNTS: { correction: 'system:correction' },
  userAccount: (id: string) => `user:${id}`,
  contribAccount: (id: string) => `contrib:${id}`,
  post: async (e: Entry) => {
    if (!e.debitAccount.startsWith('system:') && (balances[e.debitAccount] ?? 0) < e.amount) {
      return { ok: false, reason: 'insufficient_funds', message: 'Недостаточно эко на счёте' };
    }
    journal.push(e);
    balances[e.debitAccount] = (balances[e.debitAccount] ?? 0) - e.amount;
    balances[e.creditAccount] = (balances[e.creditAccount] ?? 0) + e.amount;
    return { ok: true, applied: true, id: String(journal.length) };
  },
}));

import { settleTourReviewEco, reviewEcoTarget, tourReviewRef } from '@/lib/eco/review-eco';

const U = 'u1';
function emitted(withPhoto: boolean) {
  const ref = tourReviewRef(7);
  const add = (acc: string, amount: number, source: string, sourceRef: string) => {
    journal.push({ debitAccount: 'system:emission', creditAccount: acc, amount, operation: 'emit', source, sourceRef });
    balances[acc] = (balances[acc] ?? 0) + amount;
  };
  add(`user:${U}`, 50, 'review', ref);
  add(`contrib:${U}`, 50, 'review', `${ref}:c`);
  if (withPhoto) {
    add(`user:${U}`, 20, 'photo', ref);
    add(`contrib:${U}`, 20, 'photo', `${ref}:c`);
  }
}

beforeEach(() => { journal = []; balances = {}; });

describe('цель', () => {
  it('видимый с фото — 70, без фото — 50, скрытый — 0', () => {
    expect(reviewEcoTarget({ isHidden: false, hasPhotos: true })).toBe(70);
    expect(reviewEcoTarget({ isHidden: false, hasPhotos: false })).toBe(50);
    expect(reviewEcoTarget({ isHidden: true, hasPhotos: true })).toBe(0);
  });
});

describe('сведение', () => {
  it('скрытие списывает всё начисленное — и пользу, и вклад', async () => {
    emitted(true);
    const r = await settleTourReviewEco({ id: 7, userId: U, isHidden: true, hasPhotos: true });
    expect(r.changedUser).toBe(-70);
    expect(r.changedContribution).toBe(-70);
    expect(balances[`user:${U}`]).toBe(0);
    expect(balances[`contrib:${U}`]).toBe(0);
  });

  it('повторное скрытие ничего не списывает второй раз', async () => {
    emitted(false);
    await settleTourReviewEco({ id: 7, userId: U, isHidden: true, hasPhotos: false });
    const again = await settleTourReviewEco({ id: 7, userId: U, isHidden: true, hasPhotos: false });
    expect(again.changedUser).toBe(0);
    expect(balances[`user:${U}`]).toBe(0);
  });

  it('возврат отзыва восстанавливает начисление', async () => {
    emitted(true);
    await settleTourReviewEco({ id: 7, userId: U, isHidden: true, hasPhotos: true });
    const back = await settleTourReviewEco({ id: 7, userId: U, isHidden: false, hasPhotos: true });
    expect(back.changedUser).toBe(70);
    expect(balances[`user:${U}`]).toBe(70);
  });

  it('потраченные эко: списывается остаток, недостача называется', async () => {
    emitted(true);
    balances[`user:${U}`] = 30; // 40 уже потрачено
    const r = await settleTourReviewEco({ id: 7, userId: U, isHidden: true, hasPhotos: true });
    expect(r.changedUser).toBe(-30);
    expect(r.shortfall).toBe(40);
  });

  it('отзыв, за который не начисляли (до 24.09), ничего не получает при возврате', async () => {
    const r = await settleTourReviewEco({ id: 7, userId: U, isHidden: false, hasPhotos: true });
    expect(r.changedUser).toBe(0);
    expect(journal).toHaveLength(0);
  });
});

describe('связка: модерация зовёт сведение', () => {
  it('PATCH скрытия требует причину и сводит эко', () => {
    const src = readFileSync(join(process.cwd(), 'app/api/admin/tour-reviews/[id]/route.ts'), 'utf8');
    expect(src).toMatch(/requireAdmin\(request\)/);
    expect(src).toMatch(/reason: z\.string\(\)\.trim\(\)\.min\(8/);
    expect(src).toMatch(/settleTourReviewEco\(\{/);
  });
});
