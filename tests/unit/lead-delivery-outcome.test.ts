/**
 * Итог личной доставки заявки оператору записывается и читается
 * (владелец 15.10: «точно приходят или опять предположения?»).
 *
 * Сторож держит связку целиком: производитель (роут /api/leads пишет итог
 * после notifyPartnerNewLeadPersonally), хранилище (lead_activity_log,
 * действие partner_notified, без ПД), потребитель (GET /api/admin/operators
 * отдаёт last_delivery). Отказ чтения — «не смог», а не «записей нет».
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: queryMock } }));

import { recordPartnerDelivery, lastPartnerDeliveries, PARTNER_NOTIFIED_ACTION } from '@/lib/leads/delivery-outcome';

beforeEach(() => {
  queryMock.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('recordPartnerDelivery — пишет итог в журнал заявки без ПД', () => {
  it('доставлено в MAX: строка partner_notified с исходом, каналом и временем', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const ok = await recordPartnerDelivery('lead-1', 'op-1', { state: 'delivered', channel: 'max' }, new Date('2026-10-15T02:46:12Z'));
    expect(ok).toBe(true);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO lead_activity_log/);
    expect(params[0]).toBe('lead-1');
    expect(params[1]).toBe(PARTNER_NOTIFIED_ACTION);
    expect(JSON.parse(params[2])).toEqual({ operator_id: 'op-1', at: '2026-10-15T02:46:12.000Z', state: 'delivered', channel: 'max', reason: null });
  });

  it('отказ доставки: причина записана; имени и телефона туриста в деталях нет', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await recordPartnerDelivery('lead-2', 'op-1', { state: 'failed', channel: 'max', reason: 'http_403 chat not found' });
    const details = JSON.parse(queryMock.mock.calls[0][1][2]);
    expect(details.state).toBe('failed');
    expect(details.reason).toBe('http_403 chat not found');
    expect(Object.keys(details).sort()).toEqual(['at', 'channel', 'operator_id', 'reason', 'state']);
  });

  it('нет канала: канал null, без выдуманного «доставлено»', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await recordPartnerDelivery('lead-3', 'op-2', { state: 'no_channel' });
    const details = JSON.parse(queryMock.mock.calls[0][1][2]);
    expect(details).toMatchObject({ state: 'no_channel', channel: null, reason: null });
  });

  it('база отказала — false и лог с SQLSTATE, а не тишина', async () => {
    queryMock.mockRejectedValue(Object.assign(new Error('relation does not exist'), { code: '42P01' }));
    const ok = await recordPartnerDelivery('lead-4', 'op-1', { state: 'delivered', channel: 'max' });
    expect(ok).toBe(false);
    expect(String((console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls[0])).toMatch(/SQLSTATE=42P01/);
  });
});

describe('lastPartnerDeliveries — последний итог по оператору', () => {
  it('отдаёт карту по operator_id; строку без исхода или времени пропускает', async () => {
    queryMock.mockResolvedValue({ rows: [
      { operator_id: 'op-1', lead_id: 'lead-9', details: { at: '2026-10-15T08:00:00.000Z', state: 'delivered', channel: 'max', reason: null } },
      { operator_id: 'op-2', lead_id: 'lead-8', details: { state: 'failed' } },
    ] });
    const map = await lastPartnerDeliveries(['op-1', 'op-2', 'op-3']);
    expect(map).not.toBeNull();
    expect(map!.get('op-1')).toEqual({ lead_id: 'lead-9', at: '2026-10-15T08:00:00.000Z', state: 'delivered', channel: 'max', reason: null });
    expect(map!.has('op-2')).toBe(false);
    expect(map!.has('op-3')).toBe(false);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/action = \$1/);
    expect(params).toEqual([PARTNER_NOTIFIED_ACTION, ['op-1', 'op-2', 'op-3']]);
  });

  it('пустой список — пустая карта без запроса', async () => {
    const map = await lastPartnerDeliveries([]);
    expect(map?.size).toBe(0);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('база отказала — null («не смог»), а не пустая карта («записей нет»)', async () => {
    queryMock.mockRejectedValue(Object.assign(new Error('timeout'), { code: '57014' }));
    expect(await lastPartnerDeliveries(['op-1'])).toBeNull();
  });
});
