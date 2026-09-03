// @vitest-environment node
/**
 * search_transfers у Кузьмича (02.09) — три исхода, не два.
 *
 * Прежний инструмент (удалён 01.09) читал таблицы, которых на проде не было,
 * и отвечал «трансферов не нашлось» на каждый вопрос — выдавал поломку за
 * факт. Новый читает ТОЛЬКО через listPublishedTrips (то же, что витрина) и
 * различает: нашли / искали и никто не едет / не смог проверить.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const listMock = vi.fn();
vi.mock('@/lib/transfers/service', () => ({ listPublishedTrips: (...a: unknown[]) => listMock(...a) }));
vi.mock('@/lib/config', () => ({ getPublicBaseUrl: () => 'https://vedarai.ru' }));

import { searchTransfersForKuzmich, resolveWindow } from '@/lib/kuzmich/transfer-search';

const TRIP = {
  id: 't1', vehicle_id: 'v1', trip_date: '2026-09-10', from_text: 'Петропавловск', to_text: 'Вулкан Горелый',
  to_place_id: null, to_route_id: null, departure_note: 'к шести утра', seats_total: 10, price_per_seat: '3500.00',
  is_published: true, status: 'planned', comment: null, partner_id: 'p1', partner_name: 'Камчатка-Трек',
  vehicle_kind: 'vahtovka', vehicle_title: 'КАМАЗ', seats_taken: 4, seats_free: 6,
};

beforeEach(() => { listMock.mockReset(); vi.spyOn(console, 'error').mockImplementation(() => undefined); });

describe('три исхода', () => {
  it('нашли — список с остатком, ценой, перевозчиком и ссылкой на витрину', async () => {
    listMock.mockResolvedValue([TRIP]);
    const out = await searchTransfersForKuzmich({ from: '2026-09-08', to: '2026-09-15', seats: '2', place: 'Горелый' });
    expect(out).toContain('Вулкан Горелый');
    expect(out).toContain('свободно 6 из 10');
    expect(out).toContain('3500 руб/место');
    expect(out).toContain('Камчатка-Трек');
    expect(out).toContain('https://vedarai.ru/transfers');
    expect(listMock).toHaveBeenCalledWith({ fromDate: '2026-09-08', toDate: '2026-09-15', minSeats: 2, placeId: null });
  });

  it('искали и никто не едет — факт с окном дат, не сбой', async () => {
    listMock.mockResolvedValue([]);
    const out = await searchTransfersForKuzmich({ from: '2026-09-08', to: '2026-09-15' });
    expect(out).toMatch(/никто не едет/);
    expect(out).toContain('2026-09-08');
    expect(out).toContain('не сбой');
  });

  it('направление не совпало — тоже «никто не едет в сторону», а не список чужих поездок', async () => {
    listMock.mockResolvedValue([TRIP]);
    const out = await searchTransfersForKuzmich({ place: 'Толбачик' });
    expect(out).toMatch(/никто не едет/);
    expect(out).toContain('Толбачик');
    expect(out).not.toContain('Горелый');
  });

  it('база упала — «не смог проверить», без слова «нет мест»', async () => {
    listMock.mockRejectedValue(new Error('42P01'));
    const out = await searchTransfersForKuzmich({});
    expect(out).toMatch(/Не смог проверить/);
    expect(out).not.toMatch(/никто не едет/);
  });
});

describe('окно дат', () => {
  it('без аргументов — сегодня плюс 14 дней; кривые даты не ломают', () => {
    const now = new Date('2026-09-02T10:00:00Z');
    expect(resolveWindow({}, now)).toEqual({ from: '2026-09-02', to: '2026-09-16' });
    expect(resolveWindow({ from: 'завтра', to: '2026-13-99' }, now)).toEqual({ from: '2026-09-02', to: '2026-09-16' });
  });
  it('окно шире 60 дней или «до» раньше «от» — сжимается к 14 дням от «от»', () => {
    expect(resolveWindow({ from: '2026-09-01', to: '2026-12-31' })).toEqual({ from: '2026-09-01', to: '2026-09-15' });
    expect(resolveWindow({ from: '2026-09-10', to: '2026-09-01' })).toEqual({ from: '2026-09-10', to: '2026-09-24' });
  });
});

describe('единственный путь чтения', () => {
  it('инструмент не ходит в таблицы сам и зовётся из executeTool', () => {
    const src = readFileSync(join(process.cwd(), 'lib/kuzmich/transfer-search.ts'), 'utf8');
    expect(src).not.toMatch(/FROM transfer_|db-pool|@\/lib\/database/);
    expect(src).toMatch(/listPublishedTrips/);
    const core = readFileSync(join(process.cwd(), 'lib/kuzmich/core.ts'), 'utf8');
    expect(core).toMatch(/name === 'search_transfers'/);
  });
});
