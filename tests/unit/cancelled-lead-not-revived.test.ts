/**
 * tests/unit/cancelled-lead-not-revived.test.ts
 *
 * Заявку, которую отменил клиент (`cancelled`, 1427), в работу не возвращает
 * ни одна запись статуса — не только кабинет (changeLeadStatus), но и двери
 * мимо него:
 *  - кнопки статуса под заявкой в рабочем чате (applyLeadStatus): отдельный
 *    исход «отменил клиент» — не «сбой» и не «лид не найден»;
 *  - отправка предложения клиенту (sendProposalToClient): человеку, который
 *    отказался, не пишем и «предложение отправлено» не ставим — ни по
 *    прочитанному статусу, ни если отмена пришла между чтением и захватом;
 *  - квалификация моделью (LeadAgency): отметка только пока заявка всё ещё
 *    `new`, событие в ленту — только если статус правда сменился.
 * И продавцу не говорят «готово» там, где ничего не изменилось: кабинет
 * оператора и гида на сайте отвечают 409 словами «заявку отменил клиент»
 * (а не «статус изменён» и не «уже отмечена»), повторный разбор — тоже 409.
 * Правку администратором держит tests/unit/agent-leads-closed.test.ts, сами
 * условия записей на настоящем PostgreSQL — tests/integration/request-chat.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  query: vi.fn(), dbQuery: vi.fn(), getProposal: vi.fn(), sendEmail: vi.fn(), event: vi.fn(), ai: vi.fn(),
  process: vi.fn(), change: vi.fn(), scope: vi.fn(),
}));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (sql: string, params?: unknown[]) => h.query(sql, params ?? []) } }));
vi.mock('@/lib/database', () => ({ query: (sql: string, params?: unknown[]) => h.dbQuery(sql, params ?? []) }));
vi.mock('@/lib/services/operators/lead-processor.service', () => ({
  leadProcessor: { getProposal: (...a: unknown[]) => h.getProposal(...a), process: (...a: unknown[]) => h.process(...a) },
}));
// Двери сайта: право проверяется своими сторожами — здесь судится ответ на отменённую заявку.
vi.mock('@/lib/auth/middleware', () => ({
  requireOperator: async () => ({ userId: 'u-op', role: 'operator', email: 'op@example.com' }),
  requireAdmin: async () => ({ userId: 'u-adm', role: 'admin', email: 'adm@example.com' }),
  requireRole: async () => ({ userId: 'u-guide', role: 'guide', email: 'g@example.com' }),
}));
vi.mock('@/lib/auth/guide-helpers', () => ({ getGuidePartnerId: async () => 'p-guide' }));
vi.mock('@/lib/leads/ownership', async (orig) => ({
  ...(await orig<typeof import('@/lib/leads/ownership')>()),
  canAccessLead: async () => true,
  operatorLeadScope: (...a: unknown[]) => h.scope(...a),
}));
vi.mock('@/lib/leads/owner-lead-status', async (orig) => ({
  ...(await orig<typeof import('@/lib/leads/owner-lead-status')>()),
  changeLeadStatus: (...a: unknown[]) => h.change(...a),
}));
vi.mock('@/lib/email', () => ({ sendEmail: (...a: unknown[]) => h.sendEmail(...a) }));
vi.mock('@/lib/crm/events', async (orig) => ({
  ...(await orig<typeof import('@/lib/crm/events')>()),
  recordSourceEventQuietly: (...a: unknown[]) => h.event(...a),
}));
vi.mock('@/lib/ai/providers', async (orig) => ({
  ...(await orig<typeof import('@/lib/ai/providers')>()),
  callAIWithModel: (...a: unknown[]) => h.ai(...a),
}));

import { applyLeadStatus, LEAD_STATUS_ACTION_SQL } from '@/lib/leads/status-action';
import { sendProposalToClient, PROPOSAL_CLAIM_SQL } from '@/lib/leads/proposal-delivery';
import { LeadAgency, LEAD_AGENCY_QUALIFY_SQL } from '@/lib/agents/agencies/lead-agency';
import { LeadCancelledByClientError } from '@/lib/leads/client-cancelled';
import { PATCH as operatorPatch } from '@/app/api/leads/[id]/route';
import { PATCH as guidePatch } from '@/app/api/guide/own/leads/[id]/route';
import { POST as processPost } from '@/app/api/leads/[id]/process/route';
import { NextRequest } from 'next/server';

const LEAD = '0f1e2d3c-4b5a-4968-8776-655443322110';
const fetchMock = vi.fn();

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('TELEGRAM_BOT_TOKEN', 'unit-token');
  h.event.mockResolvedValue(undefined);
  h.scope.mockResolvedValue({ kind: 'owner', partnerId: 'p-op', claimUnowned: true });
  h.sendEmail.mockResolvedValue({ success: true });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('кнопка статуса в рабочем чате', () => {
  const row = (r: { name: string | null; prev_status: string | null; updated: boolean }) => h.query.mockResolvedValue({ rows: [r], rowCount: 1 });

  it('живая заявка: статус сменён, запись — условная (третий параметр — «отменена клиентом»), событие в ленте', async () => {
    row({ name: 'Анна', prev_status: 'new', updated: true });
    expect(await applyLeadStatus('lead_contacted', LEAD)).toEqual({ outcome: 'updated', status: 'contacted', label: 'Связались', name: 'Анна' });
    expect(h.query.mock.calls).toEqual([[LEAD_STATUS_ACTION_SQL, ['contacted', LEAD, 'cancelled']]]);
    expect(h.event).toHaveBeenCalledTimes(1);
  });

  it('заявку отменил клиент: свой исход, статус не тронут, события нет — для каждой из четырёх кнопок', async () => {
    for (const prefix of ['lead_contacted', 'lead_qualified', 'lead_converted', 'lead_lost']) {
      row({ name: null, prev_status: 'cancelled', updated: false });
      expect(await applyLeadStatus(prefix, LEAD), prefix).toEqual({ outcome: 'cancelled_by_client' });
    }
    expect(h.event).not.toHaveBeenCalled();
  });

  it('лида нет — «не найден», а не «отменил клиент»; пустой ответ базы — тоже', async () => {
    row({ name: null, prev_status: null, updated: false });
    expect(await applyLeadStatus('lead_lost', LEAD)).toEqual({ outcome: 'not_found' });
    h.query.mockResolvedValue({ rows: [], rowCount: 0 });
    expect(await applyLeadStatus('lead_lost', LEAD)).toEqual({ outcome: 'not_found' });
    expect(h.event).not.toHaveBeenCalled();
  });

  it('запись не прошла у живой заявки — «не смог», а не выдуманный успех; сбой базы — с SQLSTATE в логе', async () => {
    row({ name: null, prev_status: 'new', updated: false });
    expect(await applyLeadStatus('lead_lost', LEAD)).toEqual({ outcome: 'failed', reason: 'статус не записался' });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.query.mockRejectedValue(Object.assign(new Error('boom'), { code: '22P02' }));
    expect(await applyLeadStatus('lead_lost', 'не-uuid')).toEqual({ outcome: 'failed', reason: 'SQLSTATE 22P02' });
    expect(String(spy.mock.calls.at(-1))).toContain('22P02');
    expect(h.event).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('отправка предложения клиенту', () => {
  const PROPOSAL = { headline: 'Вулканы за три дня', summary: 'Кратко', highlights: ['Горелый'], primary_tour: null, price_from: null };
  const lead = (status: string) => ({ proposal_id: 'p-1', name: 'Анна', email: 'anna@example.com', status, tg_chat_id: '555' });
  /** Чтение лида → захват → (перечитывание статуса). */
  function world(read: string, claimed: boolean, reread?: string) {
    h.query.mockImplementation(async (sql: string) => {
      if (sql === PROPOSAL_CLAIM_SQL) return claimed ? { rows: [{ prev_status: read }], rowCount: 1 } : { rows: [], rowCount: 0 };
      if (/SELECT proposal_id, name, email, status/.test(sql)) return { rows: [lead(read)], rowCount: 1 };
      if (/^SELECT status FROM leads WHERE id = \$1$/.test(sql.trim())) return { rows: reread ? [{ status: reread }] : [], rowCount: reread ? 1 : 0 };
      return { rows: [], rowCount: 0 };
    });
    h.getProposal.mockResolvedValue(PROPOSAL);
  }
  const nothingSent = () => {
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.sendEmail).not.toHaveBeenCalled();
    expect(h.event).not.toHaveBeenCalled();
  };
  const claims = () => h.query.mock.calls.filter(([s]) => s === PROPOSAL_CLAIM_SQL);

  it('заявку отменил клиент: не шлём ничего и лид не занимаем — предложение даже не читается', async () => {
    world('cancelled', true);
    expect(await sendProposalToClient(LEAD)).toEqual({ ok: false, reason: 'lead_cancelled', message: 'Заявку отменил клиент — предложение не отправляется.' });
    expect(claims()).toHaveLength(0);
    expect(h.getProposal).not.toHaveBeenCalled();
    nothingSent();
  });

  it('отмена пришла между чтением и захватом: захват условный, ответ — «отменил клиент», а не «уже отправлено»', async () => {
    world('ai_qualified', false, 'cancelled');
    expect(await sendProposalToClient(LEAD)).toMatchObject({ ok: false, reason: 'lead_cancelled' });
    expect(claims()).toEqual([[PROPOSAL_CLAIM_SQL, [LEAD, 'cancelled']]]);
    nothingSent();
  });

  it('захват не прошёл, потому что предложение уже отправлено, — прежний ответ', async () => {
    world('ai_qualified', false, 'proposal_sent');
    expect(await sendProposalToClient(LEAD)).toEqual({ ok: false, reason: 'already_sent', message: 'Предложение уже было отправлено.' });
    nothingSent();
  });

  it('живая заявка по-прежнему получает предложение', async () => {
    world('ai_qualified', true);
    const out = await sendProposalToClient(LEAD);
    expect(out).toMatchObject({ ok: true, sent: ['telegram', 'email'] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(h.sendEmail).toHaveBeenCalledTimes(1);
  });
});

describe('квалификация моделью', () => {
  const LEADS = [
    { id: 'l-1', name: 'А', phone: '+70000000001', comment: 'рыбалка на Быстрой', status: 'new' },
    { id: 'l-2', name: 'Б', phone: '+70000000002', comment: 'вулканы', status: 'new' },
  ];

  it('отметка ставится только пока заявка всё ещё новая; отменённая за время вызова модели не трогается и события не получает', async () => {
    h.ai.mockResolvedValue({ text: JSON.stringify({ analysis: [{ lead: 1, score: 9, intent: 'fishing' }, { lead: 2, score: 8, intent: 'trekking' }], recommendation: '' }) });
    h.dbQuery.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql === LEAD_AGENCY_QUALIFY_SQL) return { rows: [], rowCount: params[1] === 'l-1' ? 0 : 1 };
      return { rows: LEADS, rowCount: LEADS.length };
    });
    await new LeadAgency().qualifyLeads({ limit: 10 });
    const marks = h.dbQuery.mock.calls.filter(([s]) => s === LEAD_AGENCY_QUALIFY_SQL);
    expect(marks.map(([, p]) => (p as unknown[])[1])).toEqual(['l-1', 'l-2']);
    // l-1 клиент отменил, пока отвечала модель: строки нет — события нет; l-2 сменился — событие есть.
    expect(h.event.mock.calls.map(([e]) => (e as { sourceId: string }).sourceId)).toEqual(['l-2']);
  });
});

describe('двери сайта: продавцу не говорят «готово» по отменённой клиентом заявке', () => {
  const req = (body: unknown, method = 'PATCH') => new NextRequest(`http://localhost/api/leads/${LEAD}`, { method, body: JSON.stringify(body) });
  const params = { params: Promise.resolve({ id: LEAD }) };
  const cancelled = { kind: 'ok', changed: false, prevStatus: 'cancelled', lead: { id: LEAD, status: 'cancelled', notes: null } };

  it('кабинет оператора: смена статуса — 409 «заявку отменил клиент», а не 200 «изменён»; заметка в том же запросе — сказано, что сохранена', async () => {
    h.change.mockResolvedValue(cancelled);
    const res = await operatorPatch(req({ status: 'contacted' }), params);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'Заявку отменил клиент — статус не меняется' });

    const both = await operatorPatch(req({ status: 'lost', lostReason: 'seats', notes: 'звонил' }), params);
    expect(both.status).toBe(409);
    expect((await both.json() as { error: string }).error).toBe('Заявку отменил клиент — статус не меняется. Заметка сохранена.');
  });

  it('кабинет оператора: одна заметка к отменённой заявке — обычный успех; живая заявка — как было', async () => {
    h.change.mockResolvedValue({ ...cancelled, lead: { ...cancelled.lead, notes: 'звонил' } });
    const noted = await operatorPatch(req({ notes: 'звонил' }), params);
    expect(noted.status).toBe(200);
    expect(await noted.json()).toMatchObject({ success: true, changed: false, lead: { status: 'cancelled', notes: 'звонил' } });

    h.change.mockResolvedValue({ kind: 'ok', changed: true, prevStatus: 'new', lead: { id: LEAD, status: 'contacted', notes: null } });
    const live = await operatorPatch(req({ status: 'contacted' }), params);
    expect(live.status).toBe(200);
    expect(await live.json()).toMatchObject({ success: true, changed: true });
    // Повтор той же отметки у живой заявки — не отказ: «уже».
    h.change.mockResolvedValue({ kind: 'ok', changed: false, prevStatus: 'contacted', lead: { id: LEAD, status: 'contacted', notes: null } });
    expect((await operatorPatch(req({ status: 'contacted' }), params)).status).toBe(200);
  });

  it('кабинет гида: отметка по отменённой — 409 теми же словами, а не «уже отмечена: Связались»; живая — как было', async () => {
    h.change.mockResolvedValue(cancelled);
    const res = await guidePatch(req({ status: 'contacted' }), params);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ success: false, error: 'Заявку отменил клиент — статус не меняется' });

    h.change.mockResolvedValue({ kind: 'ok', changed: false, prevStatus: 'contacted', lead: { id: LEAD, status: 'contacted', notes: null } });
    const again = await guidePatch(req({ status: 'contacted' }), params);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ success: true, changed: false });
  });

  it('повторный разбор отменённой заявки — 409 по роду ошибки (в её словах нет «уже»), а не 500', async () => {
    const err = new LeadCancelledByClientError();
    expect(err.message).not.toMatch(/уже|не найден/);
    h.process.mockRejectedValue(err);
    const res = await processPost(req({}, 'POST'), params);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ success: false, error: 'Заявку отменил клиент — туры к ней не подбираются.' });
    // Настоящий сбой остаётся сбоем.
    h.process.mockRejectedValue(new Error('model down'));
    expect((await processPost(req({}, 'POST'), params)).status).toBe(500);
  });
});
