import { describe, it, expect, vi, beforeEach } from 'vitest';
const query = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
vi.mock('@/lib/mcp/request-status', () => ({ issueRequestKey: vi.fn(async () => 'NEWKEYabc123NEWKEYabc123') }));
import { generateHandoffCode, extractHandoffCode, redeemHandoffCode, issueHandoffCode, handoffLine } from '@/lib/requests/handoff';
import { classifyCodeFirst } from '@/lib/kuzmich/code-first';
import { readFileSync } from 'node:fs';

beforeEach(() => query.mockReset());

describe('handoff code', () => {
  it('формат и непредсказуемость', () => {
    const set = new Set(Array.from({ length: 500 }, generateHandoffCode));
    expect(set.size).toBe(500);
    for (const c of set) expect(c).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });
  it('распознаётся только целиком', () => {
    expect(extractHandoffCode('ABCD-EF2H')).toBe('ABCD-EF2H');
    expect(extractHandoffCode('код: abcd-ef2h')).toBe('ABCD-EF2H');
    expect(extractHandoffCode('KAMCHATKA')).toBeNull();
    expect(extractHandoffCode('хочу тур ABCD-EF2H завтра')).toBeNull();
    expect(classifyCodeFirst('ABCD-EF2H', false)).toEqual({ kind: 'handoff', code: 'ABCD-EF2H' });
    expect(classifyCodeFirst('ABCD-EF2H', true)).toEqual({ kind: 'handoff', code: 'ABCD-EF2H' });
  });
  it('в базу уходит хеш, не код и не ключ', async () => {
    query.mockResolvedValueOnce({ rows: [{ ok: true }] });
    const code = await issueHandoffCode('RAWKEY_secret_value_123456');
    const args = query.mock.calls[0][1] as unknown[];
    expect(JSON.stringify(args)).not.toContain(code!);
    expect(JSON.stringify(args)).not.toContain('RAWKEY_secret');
    expect(query.mock.calls[0][0]).toMatch(/live\.n < \$4/);
  });
  it('лимит живых кодов — null', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await issueHandoffCode('k')).toBeNull();
    expect(handoffLine(null)).toBe('');
  });
  it('одноразовость: атомарный UPDATE по used_at IS NULL и сроку', async () => {
    query.mockResolvedValueOnce({ rows: [{ lead_id: 'l1', seat_request_id: null, stay_request_id: null }] });
    expect(await redeemHandoffCode('ABCD-EF2H', 'telegram', 'u-1')).toEqual({ ok: true, key: 'NEWKEYabc123NEWKEYabc123' });
    expect(query.mock.calls[0][0]).toMatch(/used_at IS NULL AND expires_at > NOW\(\)/);
    query.mockResolvedValueOnce({ rows: [] });
    expect(await redeemHandoffCode('ABCD-EF2H', 'telegram', 'u-1')).toEqual({ ok: false, reason: 'invalid' });
  });
  it('лимит попыток на чат', async () => {
    query.mockResolvedValue({ rows: [] });
    const out = [];
    for (let i = 0; i < 7; i++) out.push((await redeemHandoffCode('ZZZZ-ZZ2Z', 'max', 'brute')).ok === false && (await Promise.resolve()) === undefined);
    const last = await redeemHandoffCode('ZZZZ-ZZ2Z', 'max', 'brute');
    expect(last).toEqual({ ok: false, reason: 'rate_limited' });
  });
  it('новый ключ — только статусный, без ПД в модуле', () => {
    const src = readFileSync('lib/requests/handoff.ts', 'utf8');
    expect(src).toContain('opensChat: false');
    expect(src).not.toMatch(/phone|guest_name|contact_name|email/);
  });
});
