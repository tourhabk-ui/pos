/**
 * Данные группы в МЧС из Ведара наружу не уходят (аудит 10.11) — вызовом.
 *
 * До 10.11 роут /api/operator/mchs-registrations звал registerGroupWithMchs,
 * которая POST-ила состав группы (ФИО, телефоны, даты рождения, контакты) на
 * адрес из env MCHS_API_URL. Переменная не была задана, и функция всегда
 * отвечала «не настроено». Но стоило бы кому-то её задать — ПД туристов ушли
 * бы на этот адрес без основания для такой передачи. Отправка удалена.
 *
 * Держит:
 *  - mchs-client не экспортирует ничего, что ходит в сеть;
 *  - роут при ЗАДАННОМ MCHS_API_URL сети не трогает, пишет запись «в МЧС не
 *    отправлено» и говорит оператору подать заявку самому.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const m = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => m.query(...a) }));
vi.mock('@/lib/auth/middleware', () => ({ requireOperator: async () => ({ userId: 'u1' }) }));
vi.mock('@/lib/auth/operator-helpers', () => ({ getOperatorPartnerId: async () => 'p1' }));

const client = await import('@/lib/safety/mchs-client');
const { POST } = await import('@/app/api/operator/mchs-registrations/route');

const body = {
  groupName: 'Группа на Авачинский',
  groupMembers: [{ fullName: 'Тест Тестов', phone: '+70000000000', birthDate: '1990-01-01' }],
  routeDescription: 'Авачинский перевал — вершина — перевал',
  startDate: '2027-07-19',
  endDate: '2027-07-20',
  guideContact: { fullName: 'Гид Гидов', phone: '+70000000001' },
  emergencyContacts: [{ name: 'Контакт', phone: '+70000000002' }],
  participantCount: 1,
};

describe('Ведар состав группы в МЧС не отправляет', () => {
  const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));

  beforeEach(() => {
    vi.stubEnv('MCHS_API_URL', 'https://example.invalid/register');
    vi.stubEnv('MCHS_API_TOKEN', 'x');
    vi.stubGlobal('fetch', fetchSpy);
    m.query.mockResolvedValue({ rows: [{ id: 'r1', status: 'failed', mchs_request_id: null, created_at: '2026-11-10' }], rowCount: 1 });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    fetchSpy.mockClear();
    m.query.mockReset();
  });

  it('клиент МЧС не экспортирует отправку', () => {
    expect(Object.keys(client)).not.toContain('registerGroupWithMchs');
    expect(client.MCHS_NOT_SENT.status).toBe('failed');
  });

  it('при заданном MCHS_API_URL роут сети не трогает, пишет «не отправлено» и зовёт подать самому', async () => {
    const res = await POST(new NextRequest('https://vedarai.ru/api/operator/mchs-registrations', {
      method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
    }));
    expect(res).toBeInstanceOf(NextResponse);
    expect(res.status).toBe(201);
    expect(fetchSpy).not.toHaveBeenCalled();
    const [sql, params] = m.query.mock.calls[0]! as [string, unknown[]];
    expect(sql).toContain('INSERT INTO mchs_group_registrations');
    // status, mchs_request_id, mchs_response, last_error, submitted_at
    expect(params.slice(11)).toEqual(['failed', null, 'null', 'Ведар данные группы в МЧС не передаёт', null]);
    const json = await res.json() as { message: string };
    expect(json.message).toContain('в МЧС не отправлена');
    expect(json.message).toContain('forms.mchs.gov.ru');
    expect(json.message).not.toMatch(/зарегистрирована/);
  });
});
