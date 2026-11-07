/**
 * Заявка из /planner: что уходит и что видно (проверка сценариев 07.11).
 *
 * Человек выбрал 10–17 июля, двоих взрослых и «укачивает на воде — без
 * катеров», открыл форму — и не увидел ни одного параметра, а поле пожеланий
 * было пустым. По коду: «без катеров» и режим риска в заявку не писались,
 * состав уходил только с планом, оператор в карточке и в напоминании не
 * видел ни группы, ни плана, ни пожеланий.
 *
 * Правило одно: тело заявки собирает `plannerLeadSource`, строки —
 * `tripRequestLines` из того же объекта; их рисует сводка формы, карточка
 * оператора и шлют напоминание и сообщение менеджеру. Проверка — вызовом и
 * рендером.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { NextRequest } from 'next/server';

const queryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => queryMock(...a) } }));
const alertMock = vi.fn();
vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: (...a: unknown[]) => alertMock(...a) }));
vi.mock('@/lib/crm/events', () => ({ recordSourceEventQuietly: vi.fn(), statusChangeTitle: () => 'смена статуса' }));
vi.mock('@/lib/config', () => ({ getPublicBaseUrl: () => 'https://vedarai.ru' }));
const dbQuery = vi.fn();
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => dbQuery(...a) }));

import { plannerLeadSource, tripFactsOf, tripRequestLines, wishesWords, type PlannerLeadInput } from '@/lib/planner/trip-request-lines';
import { RequestSummary } from '@/components/planner/RequestSummary';
import { LeadTripFacts } from '@/components/requests/LeadTripFacts';
import LeadDetailClient from '@/app/hub/operator/leads/[id]/_LeadDetailClient';
import { FOLLOWUP_LEADS_SQL } from '@/lib/leads/followup-scope';
import { GET } from '@/app/api/cron/leads-followup/route';
import { notifyAdminNewLead } from '@/lib/notifications/telegram-channel';

/** Сценарий проверки 07.11: 10–17 июля 2027, двое взрослых, без катеров, плана ещё нет. */
const INPUT: PlannerLeadInput = {
  interests: ['volcano'], arrival: '2027-07-10', departure: '2027-07-17', tripDays: 8,
  transportByDay: {}, adults: 2, childAges: [], seasickness: true, riskMode: 'safe_only', plan: null,
};

describe('что форма отправляет', () => {
  it('состав и пожелания — всегда, без плана тоже; заметки о здоровье нет', () => {
    const sd = plannerLeadSource(INPUT);
    expect(sd).toMatchObject({
      source: 'trip_planner', arrival: '2027-07-10', departure: '2027-07-17', trip_days: 8,
      party: { adults: 2, children: [] },
      wishes: { seasickness: true, risk_mode: 'safe_only' },
    });
    expect(sd).not.toHaveProperty('plan');
    expect(JSON.stringify(sd)).not.toMatch(/health|здоров/i);
  });

  it('ребёнок без возраста не теряется: известные возраста — списком, прочие — числом', () => {
    const sd = plannerLeadSource({ ...INPUT, childAges: [6, null] });
    expect(sd.party).toEqual({ adults: 2, children: [6], children_age_unknown: 1 });
    expect(tripRequestLines(tripFactsOf(sd))).toContain('Группа: 2 взр., ребёнок 6 лет; ещё ребёнок, возраст не указан');
  });
});

describe('строки заявки', () => {
  it('дата — только ГГГГ-ММ-ДД: свободный текст публичной формы в строки (и в заглушку Telegram) не идёт', () => {
    expect(tripRequestLines(tripFactsOf({ date_from: '2027-07-10', date_to: '2027-07-17T00:00:00Z' }))).toEqual(['Даты: 10.07.2027 — 17.07.2027']);
    const leak = tripRequestLines(tripFactsOf({ arrival: '+7 914 123-45-67', date_to: 'звоните Анне' })).join('\n');
    expect(leak).toBe('');
    expect(tripRequestLines(tripFactsOf({ arrival: '2027-07-10', departure: 'тел 89141234567' }))).toEqual(['Даты: 10.07.2027 — ?']);
  });

  it('сценарий 07.11: даты, группа, «без катеров»', () => {
    expect(tripRequestLines(tripFactsOf(plannerLeadSource(INPUT)))).toEqual([
      'Даты: 10.07.2027 — 17.07.2027 (8 дн.)',
      'Группа: 2 взр.',
      'Пожелания из анкеты: укачивает на воде — без катеров, где можно',
    ]);
  });

  it('обычный режим не называется, иной — называется; ничего не отмечено — строки нет', () => {
    expect(wishesWords({ seasickness: false, risk_mode: 'safe_only' })).toBeNull();
    expect(wishesWords({ seasickness: false, risk_mode: 'adventure' })).toBe('режим: все маршруты, включая опасные');
    expect(tripRequestLines(tripFactsOf(plannerLeadSource({ ...INPUT, seasickness: false })))).not.toContainEqual(expect.stringMatching(/Пожелания/));
  });

  it('с планом группа — из плана (с уровнем), отдельной строки нет', () => {
    const plan = {
      v: 1 as const, party: { adults: 2, children: [] }, budget_tier: 'comfort' as const, trip_origin: 'fly_in' as const, arrival: '2027-07-10',
      days: [], estimate: { people: 2, total: [100000, 120000] as [number, number], per_person: [50000, 60000] as [number, number], from_tours: [0, 0] as [number, number], lines: [], unpriced: [] },
    };
    const lines = tripRequestLines(tripFactsOf(plannerLeadSource({ ...INPUT, plan })));
    expect(lines.filter((l) => l.startsWith('Группа:'))).toEqual(['Группа: 2 взр. · уровень «комфорт»']);
    expect(lines).toContain('Пожелания из анкеты: укачивает на воде — без катеров, где можно');
  });

  it('заявка до 07.11 и чужая форма: чего нет — того нет', () => {
    expect(tripRequestLines(tripFactsOf({ interests: ['volcano'] }))).toEqual([]);
    expect(tripRequestLines(tripFactsOf({ date_from: '2027-08-01', date_to: '2027-08-05' }))).toEqual(['Даты: 01.08.2027 — 05.08.2027']);
    expect(tripRequestLines(tripFactsOf(null))).toEqual([]);
  });
});

describe('сводка в форме — то, что уйдёт', () => {
  it('строки заявки видны над контактами; заметка о здоровье — сказано, что не уходит', () => {
    const lines = tripRequestLines(tripFactsOf(plannerLeadSource(INPUT)));
    render(<RequestSummary lines={lines} healthNoted />);
    const box = screen.getByRole('region', { name: 'Что уйдёт в заявке' });
    expect(within(box).getAllByRole('listitem').map((li) => li.textContent)).toEqual(lines);
    expect(box.textContent).toMatch(/Заметка о здоровье в заявку не уходит/);
  });

  it('ничего не выбрано — сказано словами; без заметки — строки о здоровье нет', () => {
    render(<RequestSummary lines={[]} healthNoted={false} />);
    const box = screen.getByRole('region', { name: 'Что уйдёт в заявке' });
    expect(box.textContent).toMatch(/ещё не выбраны/);
    expect(box.textContent).not.toMatch(/здоровье/);
  });
});

describe('карточка оператора — те же строки', () => {
  it('блок «Из заявки» с датами, группой и пожеланиями; пустая заявка — блока нет', () => {
    const sd = plannerLeadSource(INPUT);
    const { unmount } = render(<LeadTripFacts sourceData={sd} />);
    const box = screen.getByRole('region', { name: 'Из заявки' });
    expect(within(box).getAllByRole('listitem').map((li) => li.textContent)).toEqual(tripRequestLines(tripFactsOf(sd)));
    unmount();
    const { container } = render(<LeadTripFacts sourceData={{ interests: ['volcano'] }} />);
    expect(container.textContent).toBe('');
  });
});

describe('напоминание оператору — те же строки', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = 'test-secret';
    alertMock.mockReset();
    alertMock.mockResolvedValue({ delivered: true, channel: 'max' });
    queryMock.mockReset();
    queryMock.mockImplementation(async (sql: string) => {
      if (sql === FOLLOWUP_LEADS_SQL) {
        return { rows: [{ id: 'l-plan', name: 'Анна Обычная', phone: '+79990000003', source_data: plannerLeadSource(INPUT), pd_consent_version: '2026-09-01' }] };
      }
      if (/COUNT\(\*\) AS total/.test(sql)) return { rows: [{ total: '1', with_telegram: '0', with_max: '1' }] };
      if (/FROM partners p/.test(sql)) return { rows: [{ name: 'Туроператор', slug: 'tour-op', telegram_chat_id: null, user_telegram_id: null, max_chat_id: '555' }] };
      return { rows: [] };
    });
  });

  it('оператор получает даты, группу и «без катеров» — и в MAX, и в заглушке без ПД', async () => {
    const res = await GET(new NextRequest('https://vedarai.ru/api/cron/leads-followup', { headers: { authorization: 'Bearer test-secret' } }));
    expect(res.status).toBe(200);
    expect(alertMock).toHaveBeenCalledTimes(1);
    const sent = alertMock.mock.calls[0]![0] as { text: string; stub?: string };
    for (const line of ['Даты: 10.07.2027 — 17.07.2027 (8 дн.)', 'Группа: 2 взр.', 'Пожелания из анкеты: укачивает на воде — без катеров, где можно']) {
      expect(sent.text).toContain(line);
      expect(JSON.stringify(alertMock.mock.calls[0]![0])).toContain(line);
    }
  });
});

describe('сообщение менеджеру — группа и пожелания', () => {
  it('без плана: группа и «без катеров» — в MAX и в заглушке без ПД', async () => {
    alertMock.mockReset();
    alertMock.mockResolvedValue({ channel: 'max', delivered: true, reason: 'ok' });
    dbQuery.mockResolvedValue({ rows: [] });
    await notifyAdminNewLead({
      id: '05502cc4-b983-4230-89a5-41209c10bae1', name: 'Анна Обычная', phone: '+79990000003', comment: null,
      sourceData: plannerLeadSource(INPUT), score: 60, labelRu: 'Тёплый',
    });
    const p = alertMock.mock.calls[0]![0] as { text: string; stub: string };
    for (const t of [p.text, p.stub]) {
      expect(t).toContain('<b>Группа:</b> 2 взр.');
      expect(t).toContain('<b>Пожелания из анкеты:</b> укачивает на воде — без катеров, где можно');
    }
    expect(p.stub).not.toContain('+79990000003');
  });
});

describe('карточка оператора на странице — блок «Из заявки» на месте', () => {
  it('заявка из планера: даты, группа и «без катеров» видны оператору', async () => {
    const lead = {
      id: 'l-1', name: 'Анна Обычная', phone: '+79990000003', email: null, comment: null, route_id: null, route_title: null,
      source_url: '/planner', source_data: plannerLeadSource(INPUT), status: 'new', notes: null,
      created_at: '2026-11-07T00:00:00Z', updated_at: '2026-11-07T00:00:00Z', has_recipient: true,
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const body = String(url).endsWith('/proposal') ? { proposal: null } : { lead, bookings: [] };
      return { ok: true, status: 200, json: async () => body } as Response;
    }));
    render(<LeadDetailClient leadId="l-1" />);
    const box = await screen.findByRole('region', { name: 'Из заявки' });
    expect(within(box).getAllByRole('listitem').map((li) => li.textContent)).toEqual(tripRequestLines(tripFactsOf(lead.source_data)));
    vi.unstubAllGlobals();
  });
});
