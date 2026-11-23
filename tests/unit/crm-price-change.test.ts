import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { CHANGE_TTL_MS, confirmPendingChange, confirmUrl, createPendingChange, loadPendingChange } from '@/lib/crm/price-change';

// Запись цены — единая дверь владельца (lib/tours/tour-change, этап 4 плана
// готовности 23.11). Здесь она подменена: судим, что подтверждение сверяет
// цену с предпросмотром и раскладывает туры по трём спискам. Сама дверь и
// очередь проверяются на PostgreSQL — tests/integration/tour-moderation.pg.test.ts.
const door = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock('@/lib/tours/tour-change', () => ({ saveTourChange: door.save }));

const ID = '11111111-2222-3333-4444-555555555555';
const NOW = Date.parse('2026-11-03T08:00:00Z');
const preview = (kind: 'base_price' | 'weekend_markup') => ({
  change: { kind, percent: 10, tourIds: 'all' }, sampleDate: '2026-11-07',
  tours: [{ tourId: 7, title: 'Вулкан', baseBefore: 12950, baseAfter: kind === 'base_price' ? 14245 : 12950, saturdayBefore: 12950, saturdayAfter: 14245, tiersOverride: false }],
});
function db(row: any, updates = 1) {
  const calls: [string, any[]][] = [];
  return { calls, query: vi.fn(async (sql: string, p: any[]) => {
    calls.push([sql, p]);
    if (sql.startsWith('SELECT id::text')) return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    if (sql.includes('SELECT id::int AS id FROM operator_tours')) return { rows: [{ id: 7 }], rowCount: 1 };
    if (sql.includes('INSERT INTO operator_price_changes')) return { rows: [{ id: ID }], rowCount: 1 };
    return { rows: [], rowCount: updates };
  }) } as any;
}
const open = (kind: any) => ({ id: ID, change: preview(kind).change, preview: preview(kind), used_at: null, expires_at: new Date(NOW + CHANGE_TTL_MS) });

describe('подтверждение цен — K.ai B3', () => {
  it('ссылка — только id, 24 часа', async () => {
    expect(confirmUrl(ID)).toMatch(/\/hub\/operator\/pricing\/confirm\?id=11111111-/);
    const d = db(null);
    await createPendingChange(d, 'op', preview('base_price') as any, NOW);
    expect(d.calls[0][1][5] - d.calls[0][1][4]).toBe(24 * 3600_000);
    expect(readFileSync('migrations/1379_operator_price_changes.sql', 'utf8')).toMatch(/INTERVAL '24 hours'/);
  });
  it('чужое/кривое id — не найдено', async () => {
    expect(await loadPendingChange(db(null), 'op', 'x; drop', NOW)).toBeNull();
    expect(await confirmPendingChange(db(null), 'op', ID, 'u', NOW)).toEqual({ outcome: 'not_found' });
  });
  it('истекло и использовано — не применяется', async () => {
    expect(await confirmPendingChange(db({ ...open('base_price'), expires_at: new Date(NOW - 1) }), 'op', ID, 'u', NOW)).toEqual({ outcome: 'expired' });
    expect(await confirmPendingChange(db({ ...open('base_price'), used_at: new Date(NOW) }), 'op', ID, 'u', NOW)).toEqual({ outcome: 'used' });
    expect(await confirmPendingChange(db(open('base_price'), 0), 'op', ID, 'u', NOW)).toEqual({ outcome: 'used' }); // гонка двух кликов
  });
  it('база: ставит показанное и только если цена не менялась', async () => {
    door.save.mockReset().mockResolvedValue({ outcome: 'written', row: { id: '7', title: 'Вулкан', updated_at: '' }, pending: null });
    const d = db(open('base_price'));
    expect(await confirmPendingChange(d, 'op', ID, 'u', NOW)).toEqual({ outcome: 'applied', applied: [7], pending: [], skipped: [] });
    // Сверка с предпросмотром — под замком строки, по цене «было».
    const same = d.calls.find(([s]: any) => s.includes('FROM operator_tours') && s.includes('FOR UPDATE'));
    expect(same[0]).toMatch(/base_price = \$3/);
    expect(same[1]).toEqual([7, 'op', 12950]);
    // Пишется показанная цена — через дверь владельца, от имени подтвердившего.
    expect(door.save).toHaveBeenCalledTimes(1);
    expect(door.save.mock.calls[0][1]).toMatchObject({ tourId: '7', ownerId: 'op', userId: 'u', input: { base_price: 14245 } });
    // Своего UPDATE цены у подтверждения нет: мимо двери цена на витрину не попадает.
    expect(d.calls.some(([s]: any) => /UPDATE operator_tours/.test(s))).toBe(false);
  });
  it('база: цена менялась после предпросмотра — тур пропущен, дверь не звана', async () => {
    door.save.mockReset();
    const d = db(open('base_price'));
    d.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT id::text')) return { rows: [open('base_price')], rowCount: 1 };
      if (sql.includes('FOR UPDATE')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    });
    expect(await confirmPendingChange(d, 'op', ID, 'u', NOW)).toEqual({ outcome: 'applied', applied: [], pending: [], skipped: [7] });
    expect(door.save).not.toHaveBeenCalled();
  });
  it('база: тур на витрине — цена ушла на проверку, в «изменено» его нет', async () => {
    door.save.mockReset().mockResolvedValue({
      outcome: 'pending', row: null,
      pending: { editId: 'e', fields: ['base_price'], wantsPublish: false, notice: 'Правка отправлена на проверку (цена). На витрине пока прежняя версия.' },
    });
    expect(await confirmPendingChange(db(open('base_price')), 'op', ID, 'u', NOW))
      .toEqual({ outcome: 'applied', applied: [], pending: [7], skipped: [] });
  });
  it('наценка: через setWeekendMarkup', async () => {
    const d = db(open('weekend_markup'));
    expect(await confirmPendingChange(d, 'op', ID, 'u', NOW)).toMatchObject({ outcome: 'applied', applied: [7] });
    expect(d.calls.some(([s]: any) => s.includes("'weekend_sat_sun', $2"))).toBe(true);
  });
});
