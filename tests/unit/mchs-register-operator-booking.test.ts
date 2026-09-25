/**
 * Регистрация группы в МЧС из кабинета оператора создаётся по НОМЕРУ брони
 * оператора (operator_bookings.id, bigint), а не по UUID.
 *
 * До правки: Zod требовал .uuid(), форма просила «UUID бронирования», а
 * сверка шла с bigint-колонкой — 22P02 на каждом запросе, запись не
 * создавалась никогда. mchs_registrations.booking_id при этом ссылался на
 * старую bookings (uuid); миграция 1016 завела operator_booking_id.
 *
 * Отдельно: экран mchs-registrations писал «Группа автоматически
 * зарегистрирована в МЧС» при статусе submitted — то есть когда заявка лишь
 * ушла на адрес MCHS_API_URL без подтверждения.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest, NextResponse } from 'next/server';

const queryMock = vi.fn();
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => queryMock(...a) }));
vi.mock('@/lib/auth/middleware', () => ({
  requireOperator: vi.fn(async () => ({ userId: '11111111-1111-4111-8111-111111111111', role: 'operator' })),
}));
vi.mock('@/lib/auth/operator-helpers', () => ({
  getOperatorPartnerId: vi.fn(async () => '22222222-2222-4222-8222-222222222222'),
}));

import { POST } from '@/app/api/operator/mchs/register/route';
import { mchsOutcomeMessage } from '@/lib/safety/mchs-client';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

function body(bookingId: unknown) {
  return {
    bookingId,
    groupComposition: [{ fullName: 'Иван Петров' }],
    route: 'Авачинский перевал',
    startDate: '2026-10-01',
    endDate: '2026-10-02',
    guideContacts: { name: 'Гид Гидов', phone: '+79140000000' },
    emergencyContacts: [{ name: 'Мария', phone: '+79140000001' }],
  };
}

function req(payload: unknown) {
  return new NextRequest('http://localhost/api/operator/mchs/register', {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  queryMock.mockReset();
});

describe('POST /api/operator/mchs/register', () => {
  it('принимает числовой номер брони и пишет его в operator_booking_id', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: '1042' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'r1', status: 'pending', created_at: '2026-09-25' }] });
    const res = await POST(req(body(1042)));
    expect(res.status).toBe(201);

    const [ownSql, ownParams] = queryMock.mock.calls[0];
    expect(String(ownSql)).toMatch(/b\.id\s*=\s*\$1::bigint/);
    expect(String(ownSql)).toMatch(/JOIN partners p/);
    expect(String(ownSql)).toMatch(/p\.category\s*=\s*'operator'/);
    expect(ownParams[0]).toBe(1042);

    const [insSql, insParams] = queryMock.mock.calls[1];
    expect(String(insSql)).toMatch(/operator_booking_id/);
    expect(String(insSql)).not.toMatch(/\(\s*booking_id,/);
    expect(insParams[0]).toBe(1042);
  });

  it('строка с числом тоже принимается (поле формы — текст)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: '7' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'r1', status: 'pending', created_at: '2026-09-25' }] });
    const res = await POST(req(body('7')));
    expect(res.status).toBe(201);
    expect(queryMock.mock.calls[0][1][0]).toBe(7);
  });

  it('UUID вместо номера — 400 с текстом ошибки, а не массивом', async () => {
    const res = await POST(req(body('5f3c1a2b-0000-4000-8000-000000000000')));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: unknown };
    expect(typeof json.error).toBe('string');
    expect(String(json.error)).toMatch(/брон/i);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('чужая бронь — 404 с номером брони в тексте', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const res = await POST(req(body(99)));
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain('99');
  });

  it('отказ БД — в лог с SQLSTATE, наружу без текста PostgreSQL', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    queryMock.mockRejectedValueOnce(Object.assign(new Error('relation secret_table'), { code: '42P01' }));
    const res = await POST(req(body(5)));
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: string };
    expect(json.error).not.toContain('secret_table');
    expect(spy.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('42P01');
    spy.mockRestore();
  });
});

describe('форма МЧС в кабинете', () => {
  const panel = read('components/operator/Dashboard/MchsRegistrationPanel.tsx');
  it('просит номер брони, а не UUID', () => {
    expect(panel).toContain('Номер брони');
    expect(panel).not.toMatch(/UUID бронирования/);
  });
  it('ошибка сервера показывается текстом, запасной текст называет HTTP-код', () => {
    expect(panel).toMatch(/Сервер не принял регистрацию \(HTTP \$\{response\.status\}\)/);
    expect(panel).not.toMatch(/'Не удалось создать регистрацию'/);
  });
});

describe('миграция 1016', () => {
  const sql = read('migrations/1014_mchs_registrations_operator_booking.sql');
  it('заводит operator_booking_id BIGINT с FK на operator_bookings, идемпотентно', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS operator_booking_id BIGINT/);
    expect(sql).toMatch(/REFERENCES operator_bookings\(id\)/);
  });
});

describe('исход отправки в МЧС называется по факту', () => {
  it('submitted — НЕ «зарегистрирована», а «подтверждения нет»', () => {
    const m = mchsOutcomeMessage('submitted', null, null);
    expect(m).not.toMatch(/зарегистрирована/i);
    expect(m).toMatch(/подтверждения регистрации в МЧС нет/);
    expect(m.includes('forms.mchs.gov.ru')).toBe(true);
  });
  it('failed — сохранено, но не отправлено, с причиной', () => {
    const m = mchsOutcomeMessage('failed', null, 'MCHS_API_URL не настроен');
    expect(m).toMatch(/не отправлена/);
    expect(m).toContain('MCHS_API_URL не настроен');
  });
  it('экран больше не обещает автоматическую регистрацию', () => {
    const route = read('app/api/operator/mchs-registrations/route.ts');
    expect(route).not.toMatch(/автоматически зарегистрирована/);
    expect(route).toContain('mchsOutcomeMessage(');
  });
});
