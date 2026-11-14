/**
 * Заявка без адресата: имя и контакты — после взятия (слово владельца 14.11
 * «скрывать до взятия»).
 *
 * Судится поведением:
 *  - маска строки — вызовом `hideUnclaimedContact` на граничных данных;
 *  - пять дверей, читающих контакт или пишущих человеку (предложение, PDF,
 *    отправка, два разбора), — вызовом: у не взятой заявки 409 и само
 *    действие не зовётся, у чужой — 404, у своей — действие идёт;
 *  - «Взять заявку» — вызовом PATCH: правило смены получает пустую смену,
 *    которая только занимает заявку, а «уже взяла другая» сказано словами.
 * Список и экраны — tests/unit/leads-unowned-pool.test.tsx; настоящий
 * PostgreSQL — сцена в tests/integration/tourist-cabinet.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  user: { userId: 'u-op', role: 'operator' } as { userId: string; role: string },
  /** operator_id заявки в базе; 'missing' — строки нет (чужая или нет такой). */
  leadOperator: null as string | null | 'missing',
  process: vi.fn(async () => ({ proposal_id: 'PR', headline: 'Иван, вулкан в августе', ai_score: 80, generation_ms: 10, primary_tour: null, alt_tours: [] })),
  getProposal: vi.fn(async () => ({ id: 'PR', lead_name: 'Иван', lead_phone: '+79140000000' })),
  send: vi.fn(async () => ({ ok: true, channel: 'email' })),
  change: vi.fn(async () => ({ kind: 'ok', changed: false, prevStatus: 'new', lead: { id: 'L1', status: 'new', notes: null } })),
}));

vi.mock('@/lib/auth/middleware', () => ({
  requireOperator: async () => h.user,
  requireAdmin: async () => h.user,
  requireRole: async () => h.user,
}));
vi.mock('@/lib/operators/team-access', () => ({
  operatorAccess: async () => ({ kind: 'owner', partnerId: 'P-OWN' }),
}));
vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: vi.fn(async (sql: string) => {
      if (/SELECT is_public FROM partners/.test(sql)) return { rows: [{ is_public: true }] };
      if (/SELECT operator_id FROM leads/.test(sql)) {
        return { rows: h.leadOperator === 'missing' ? [] : [{ operator_id: h.leadOperator }] };
      }
      if (/SELECT proposal_id/.test(sql)) return { rows: [{ proposal_id: 'PR', name: 'Иван' }] };
      throw new Error(`неожиданный запрос: ${sql.slice(0, 80)}`);
    }),
  },
}));
vi.mock('@/lib/services/operators/lead-processor.service', () => ({
  leadProcessor: { process: h.process, getProposal: h.getProposal },
}));
vi.mock('@/lib/leads/proposal-delivery', () => ({ sendProposalToClient: h.send }));
vi.mock('@/lib/pdf/proposal-generator', () => ({ generateProposalPDF: async () => Buffer.from('%PDF') }));
vi.mock('@/lib/notifications/lead-notify', () => ({ notifyOperatorProposal: async () => {} }));
vi.mock('@/lib/leads/owner-lead-status', async (orig) => ({
  ...(await orig<typeof import('@/lib/leads/owner-lead-status')>()),
  changeLeadStatus: h.change,
}));

import { hideUnclaimedContact, HIDDEN_NAME } from '@/lib/leads/unclaimed-contact';
import { CLAIM_FIRST_TEXT } from '@/lib/leads/ownership';
import { GET as proposalGET } from '@/app/api/leads/[id]/proposal/route';
import { GET as pdfGET } from '@/app/api/leads/[id]/proposal/pdf/route';
import { POST as sendPOST } from '@/app/api/leads/[id]/proposal/send/route';
import { POST as processByIdPOST } from '@/app/api/leads/[id]/process/route';
import { POST as processPOST } from '@/app/api/leads/process/route';
import { PATCH } from '@/app/api/leads/[id]/route';

const LEAD = '11111111-1111-4111-8111-111111111111';
const params = { params: Promise.resolve({ id: LEAD }) };
const req = (body?: unknown, method = 'POST') => new NextRequest(new URL(`/api/leads/${LEAD}`, 'https://vedarai.ru'), {
  method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
});

beforeEach(() => {
  h.user = { userId: 'u-op', role: 'operator' };
  h.leadOperator = null;
  for (const f of [h.process, h.getProposal, h.send, h.change]) f.mockClear();
});

describe('маска строки заявки', () => {
  const owner = { kind: 'owner', partnerId: 'P-OWN', claimUnowned: true } as const;
  const row = {
    id: 'L1', operator_id: null as string | null, name: 'Иван Петров', phone: '+79140001122', email: 'ivan@example.com',
    comment: 'Хотим на вулкан в августе, 4 человека. Звоните +7 914 000-11-22, Иван Петров',
    notes: null, ai_summary: 'Иван Петров хочет на вулкан',
    source_data: {
      source: 'telegram_bot', participants: 4, date_from: '2027-08-10',
      telegram_username: 'ivanp', chat_id: 12345, max_chat_id: 777, telegram_user_id: 99,
      trip_parts: [{ kind: 'stay', guest_name: 'Иван Петров', nights: 3 }],
    },
  };

  it('не взятая заявка без адресата: ни имени, ни телефона, ни почты, ни идентификаторов', () => {
    const out = hideUnclaimedContact(owner, row);
    expect(out.contact_hidden).toBe(true);
    expect(out.name).toBe(HIDDEN_NAME);
    expect(out.phone).toBe('');
    expect(out.email).toBeNull();
    const text = JSON.stringify(out);
    for (const pd of ['Иван', '+79140001122', '000-11-22', 'ivan@example.com', 'ivanp', '12345', '777']) {
      expect(text, pd).not.toContain(pd);
    }
    // Что просят — остаётся: даты, состав, откуда пришла.
    expect(out.comment).toContain('Хотим на вулкан в августе, 4 человека');
    expect(out.source_data).toMatchObject({ source: 'telegram_bot', participants: 4, date_from: '2027-08-10' });
    expect((out.source_data as { trip_parts: unknown[] }).trip_parts).toEqual([{ kind: 'stay', nights: 3 }]);
  });

  it('своя заявка и администратор — как есть', () => {
    expect(hideUnclaimedContact(owner, { ...row, operator_id: 'P-OWN' })).toEqual({ ...row, operator_id: 'P-OWN', contact_hidden: false });
    expect(hideUnclaimedContact({ kind: 'admin' }, row)).toEqual({ ...row, contact_hidden: false });
  });
});

describe('предложение, PDF, отправка и разбор — после взятия', () => {
  const doors = [
    ['GET предложение', () => proposalGET(req(undefined, 'GET'), params), h.getProposal],
    ['GET PDF', () => pdfGET(req(undefined, 'GET'), params), h.getProposal],
    ['POST отправка', () => sendPOST(req({ channel: 'email' }), params), h.send],
    ['POST разбор по id', () => processByIdPOST(req({}), params), h.process],
    ['POST разбор по телу', () => processPOST(new NextRequest(new URL('/api/leads/process', 'https://vedarai.ru'), {
      method: 'POST', body: JSON.stringify({ lead_id: LEAD }), headers: { 'content-type': 'application/json' },
    })), h.process],
  ] as const;

  for (const [name, call, action] of doors) {
    it(`${name}: не взята — 409 «сначала возьмите», действие не зовётся`, async () => {
      h.leadOperator = null;
      const res = await call();
      expect(res.status).toBe(409);
      expect(JSON.stringify(await res.json())).toContain(CLAIM_FIRST_TEXT);
      expect(action).not.toHaveBeenCalled();
    });

    it(`${name}: чужая или нет такой — 404; своя — действие идёт`, async () => {
      h.leadOperator = 'missing';
      expect((await call()).status).toBe(404);
      expect(action).not.toHaveBeenCalled();
      h.leadOperator = 'P-OWN';
      const res = await call();
      expect(res.status).toBeLessThan(400);
      expect(action).toHaveBeenCalled();
    });
  }
});

describe('PDF предложения скачивается и у заявки с русским именем', () => {
  it('заголовок — латиницей, имя по-русски — в filename* (RFC 5987)', async () => {
    h.leadOperator = 'P-OWN';
    const res = await pdfGET(req(undefined, 'GET'), params);
    expect(res.status).toBe(200);
    const cd = res.headers.get('content-disposition') ?? '';
    expect(cd).toMatch(/^attachment; filename="proposal-[0-9a-f]{8}\.pdf"; filename\*=UTF-8''/);
    expect(decodeURIComponent(cd.split("UTF-8''")[1]!)).toMatch(/^proposal-Иван-\d+\.pdf$/);
  });
});

describe('«Взять заявку»', () => {
  it('PATCH { claim: true } — пустая смена, которая только занимает заявку', async () => {
    const res = await PATCH(req({ claim: true }, 'PATCH'), params);
    expect(res.status).toBe(200);
    expect(h.change).toHaveBeenCalledTimes(1);
    const args = (h.change.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(args).toMatchObject({ leadId: LEAD, status: undefined, notes: undefined });
    expect(args.scope).toEqual({ kind: 'owner', partnerId: 'P-OWN', claimUnowned: true });
  });

  it('взять не вышло — сказано, что заявку могла взять другая компания', async () => {
    h.change.mockResolvedValueOnce({ kind: 'not_found' } as never);
    const res = await PATCH(req({ claim: true }, 'PATCH'), params);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Заявка не найдена или её уже взяла другая компания');
  });

  it('пустой запрос без claim — по-прежнему «нечего обновлять»', async () => {
    const res = await PATCH(req({}, 'PATCH'), params);
    expect(res.status).toBe(400);
    expect(h.change).not.toHaveBeenCalled();
  });
});
