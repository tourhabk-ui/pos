import { describe, expect, it, vi } from 'vitest';
import { cabinetPayload, parseCabinetPress } from '@/lib/chat-cabinet/payload';
import { reportScreen } from '@/lib/chat-cabinet/screens';
import { foldRows } from '@/lib/crm/report-period';
import { crmToolDefinitions, executeCrmTool, CRM_WRITE_TOOL_NAMES } from '@/lib/crm/tools';

describe('отчёт в чате (A2)', () => {
  it('payload туда и обратно', () => {
    for (const p of ['this_week', 'last_week', 'this_month', 'last_month'] as const) {
      expect(parseCabinetPress(cabinetPayload.report(p))).toEqual({ kind: 'report', period: p });
    }
    expect(parseCabinetPress('cb:rp:x')).toBeNull();
  });
  it('экран без ПД (идёт в Telegram), с кнопками других периодов', () => {
    const s = reportScreen({ period: 'last_week', from: '2026-10-26', to: '2026-11-01', byCreated: foldRows([], 'created'), byTrip: foldRows([], 'trip'), leads: 0 }, 'last_week');
    expect(s.pd).toBe(false);
    expect(s.rows.flat().map((b) => b.payload)).toEqual(expect.arrayContaining(['cb:rp:w', 'cb:rp:m', 'cb:rp:lm']));
    expect(s.rows.flat().map((b) => b.payload)).not.toContain('cb:rp:lw');
  });
  it('crm_report — только чтение', () => {
    expect(CRM_WRITE_TOOL_NAMES).not.toContain('crm_report');
    expect(crmToolDefinitions(false).map((d) => d.function.name)).toContain('crm_report');
  });
});

describe('crm_report: не оператор и сбой чтения', () => {
  it('гиду — отказ, базу не трогает', async () => {
    const db = { query: vi.fn() };
    const r = await executeCrmTool('crm_report', { period: 'last_week' }, { partnerId: '00000000-0000-0000-0000-000000000001', category: 'guide', userId: null, actor: 'kuzmich', canWrite: false }, db as never);
    expect(r.ok).toBe(false);
    expect(db.query).not.toHaveBeenCalled();
  });
  it('сбой базы — без цифр', async () => {
    const db = { query: vi.fn().mockRejectedValue(Object.assign(new Error('x'), { code: '57014' })) };
    const r = await executeCrmTool('crm_report', { period: 'this_month' }, { partnerId: '00000000-0000-0000-0000-000000000001', category: 'operator', userId: null, actor: 'kuzmich', canWrite: false }, db as never);
    expect(r).toMatchObject({ ok: false });
  });
});
