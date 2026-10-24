/**
 * Новая заявка — лично оператору, которому она адресована (13.10).
 *
 * Что было: форма на странице оператора (vedarai.ru/<slug>, #2414) и виджет
 * на его сайте клали лид в ЕГО кабинет (lead.operator_id), а уведомление
 * уходило только в рабочий чат платформы. Оператор узнавал о заявке, когда
 * заходил в кабинет сам. Личная доставка оператору на платформе уже была —
 * у брони (notifyNewBooking: reachForPartner → sendPdAlert({ to })).
 *
 * Что держит сторож:
 *  - адрес берётся у ОПЕРАТОРА (`to`), без отката на рабочий чат: ПД туриста
 *    в чужой чат — не доставка (pd-alert, строгий режим);
 *  - ПД — только в тексте для MAX, в заглушке для Telegram их нет;
 *  - оператору лично — ссылка и четыре ответа (Принять / Нет мест / Уточнить /
 *    Свяжусь сам), если id заявки разбирается; команде — только ссылка;
 *    заглушка Telegram без имени, телефона и без текста кнопок;
 *  - исходов четыре: доставлено / заглушка / нет канала / адрес не прочитался
 *    — «не смог» не выдаётся за «доставлено»;
 *  - рабочий чат видит, дошло ли до оператора лично и кого привязывать;
 *  - роут /api/leads зовёт личную доставку, а slug страницы оператора
 *    резолвится по публичности карточки, не только по включённому виджету.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { reachMock, pdMock, teamMock } = vi.hoisted(() => ({ reachMock: vi.fn(), pdMock: vi.fn(), teamMock: vi.fn() }));
vi.mock('@/lib/partners/reach', () => ({ reachForPartner: reachMock }));
// Копия команде кабинета (CRM 2г-4) — своим модулем со своим сторожем.
vi.mock('@/lib/operators/team-notify', () => ({ notifyTeam: teamMock }));
vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: pdMock }));
vi.mock('@/lib/config', () => ({ getPublicBaseUrl: () => 'https://vedarai.ru' }));

import { notifyPartnerNewLeadPersonally, notifyOperatorNewLead } from '@/lib/notifications/lead-notify';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const LEAD = { operatorId: 'op-mestechko', leadId: 'lead-1', name: 'Анна', phone: '+79990000000', comment: 'Толбачик, двое' };
const BOUND = { maxChatId: '111', telegramChatId: '222', telegramSource: 'partner' as const, reachable: true };

type PdArgs = { text: string; stub: string; buttons?: Array<Record<string, string>>; to?: { maxChatId?: unknown; telegramChatId?: unknown } };
const lastPdArgs = () => pdMock.mock.calls[pdMock.mock.calls.length - 1][0] as PdArgs;

beforeEach(() => {
  reachMock.mockReset();
  pdMock.mockReset();
  pdMock.mockResolvedValue({ channel: 'max', delivered: true, reason: 'ok' });
  teamMock.mockReset();
  teamMock.mockResolvedValue({ state: 'sent', members: 0, delivered: 0, stubbed: 0 });
});

describe('notifyPartnerNewLeadPersonally — адрес оператора, ПД только в MAX', () => {
  it('привязанный оператор: ПД в его MAX, заглушка без ПД, четыре ответа и ссылка', async () => {
    const leadId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    reachMock.mockResolvedValue(BOUND);
    const outcome = await notifyPartnerNewLeadPersonally({
      ...LEAD, leadId, origin: 'форма на вашей странице на Ведаре', sourceUrl: 'https://vedarai.ru/mestechko',
    });
    expect(outcome).toEqual({ state: 'delivered', channel: 'max' });
    expect(reachMock).toHaveBeenCalledWith('op-mestechko');
    expect(pdMock).toHaveBeenCalledTimes(1);
    const args = lastPdArgs();
    expect(args.to).toEqual({ maxChatId: '111', telegramChatId: '222' });
    expect(args.text).toContain('Анна');
    expect(args.text).toContain('+79990000000');
    expect(args.text).toContain('Толбачик');
    expect(args.text).toContain('Это ответ, не подтверждение брони');
    expect(args.stub).not.toContain('Анна');
    expect(args.stub).not.toContain('+79990000000');
    expect(args.stub).not.toContain('Принять');
    expect(args.stub).toContain(leadId);
    expect(args.text).toContain('форма на вашей странице на Ведаре');
    expect(args.stub).toContain('https://vedarai.ru/mestechko');
    expect(args.buttons).toEqual([
      { text: 'Открыть заявку', url: `https://vedarai.ru/hub/operator/leads/${leadId}` },
      { text: 'Принять', payload: `ia:a:l:${leadId}` },
      { text: 'Нет мест', payload: `ia:n:l:${leadId}` },
      { text: 'Уточнить', payload: `ia:c:l:${leadId}` },
      { text: 'Свяжусь сам', payload: `ia:m:l:${leadId}` },
    ]);
    const [, teamMsg] = teamMock.mock.calls[0] as [string, { text: string; buttons: Array<Record<string, string>> }];
    expect(teamMsg.buttons).toEqual([{ text: 'Открыть заявку', url: `https://vedarai.ru/hub/operator/leads/${leadId}` }]);
    expect(teamMsg.text).not.toContain('Это ответ, не подтверждение брони');
  });

  it('оператор не привязан → no_channel, кабинету ничего не шлётся; команде — тот же текст своим адресом', async () => {
    reachMock.mockResolvedValue({ maxChatId: null, telegramChatId: null, telegramSource: null, reachable: false });
    expect(await notifyPartnerNewLeadPersonally(LEAD)).toEqual({ state: 'no_channel' });
    expect(pdMock).not.toHaveBeenCalled();
    // Заявка доходит до менеджеров, даже если у кабинета канала нет (2г-4).
    expect(teamMock).toHaveBeenCalledTimes(1);
    const [partnerId, msg] = teamMock.mock.calls[0] as [string, { text: string; stub: string; buttons: Array<Record<string, string>> }];
    expect(partnerId).toBe('op-mestechko');
    expect(msg.text).toContain('+79990000000');
    expect(msg.stub).not.toContain('+79990000000');
    expect(msg.buttons.every((b) => 'url' in b && !('payload' in b))).toBe(true);
  });

  it('адрес не прочитался → unknown, а не «адреса нет»', async () => {
    reachMock.mockResolvedValue(null);
    expect(await notifyPartnerNewLeadPersonally(LEAD)).toEqual({ state: 'unknown' });
    expect(pdMock).not.toHaveBeenCalled();
  });

  it('заглушка и отказ — не доставка', async () => {
    reachMock.mockResolvedValue(BOUND);
    pdMock.mockResolvedValueOnce({ channel: 'telegram-stub', delivered: false, reason: 'у получателя нет max_chat_id' });
    expect(await notifyPartnerNewLeadPersonally(LEAD)).toEqual({ state: 'stub', channel: 'telegram-stub' });
    pdMock.mockResolvedValueOnce({ channel: 'none', delivered: false, reason: 'MAX ответил 500' });
    expect(await notifyPartnerNewLeadPersonally(LEAD)).toEqual({ state: 'failed', channel: 'none', reason: 'MAX ответил 500' });
  });
});

describe('рабочий чат платформы видит исход личной доставки', () => {
  it('не привязан → строка о привязке в тексте и в заглушке; адрес рабочего чата — по умолчанию', async () => {
    await notifyOperatorNewLead({ leadId: 'lead-1', name: 'Анна', phone: '+79990000000', forPartner: { name: 'Местечко Камчатка', outcome: { state: 'no_channel' } } });
    const args = lastPdArgs();
    expect(args.to).toBeUndefined();
    for (const body of [args.text, args.stub]) {
      expect(body).toContain('Оператор «Местечко Камчатка» не привязан');
      expect(body).toContain('Привязать мессенджер');
    }
    expect(args.stub).not.toContain('+79990000000');
  });

  it('доставлено лично → так и написано; без forPartner строки нет', async () => {
    await notifyOperatorNewLead({ leadId: 'lead-1', name: 'Анна', phone: '+79990000000', forPartner: { name: 'Местечко Камчатка', outcome: { state: 'delivered', channel: 'max' } } });
    expect(lastPdArgs().text).toContain('Оператор «Местечко Камчатка»: доставлено лично в MAX');
    await notifyOperatorNewLead({ leadId: 'lead-2', name: 'Анна', phone: '+79990000000' });
    expect(lastPdArgs().text).not.toContain('Оператор «');
  });
});

describe('роут /api/leads — по исходнику', () => {
  const ROUTE = read('app/api/leads/route.ts');
  const NOTIFY = read('lib/notifications/lead-notify.ts');

  it('заявка с оператором уходит ему лично, потом — рабочему чату с исходом', () => {
    expect(ROUTE).toMatch(/notifyPartnerNewLeadPersonally\(\{/);
    expect(ROUTE.indexOf('notifyPartnerNewLeadPersonally({')).toBeLessThan(ROUTE.indexOf('forPartner:'));
    expect(ROUTE).toMatch(/outcome: personal/);
  });

  it('slug со страницы оператора резолвится по публичности карточки, не только по виджету', () => {
    expect(ROUTE).toMatch(/FROM partners WHERE slug = \$1 AND \(widget_enabled = true OR is_public = true\)/);
  });

  it('лично оператору — четыре ответа и ссылка; команде — только ссылка', () => {
    const fn = NOTIFY.slice(NOTIFY.indexOf('export async function notifyPartnerNewLeadPersonally'));
    expect(fn).toMatch(/incomingAnswerButtons\('lead', params\.leadId\)/);
    expect(fn).toMatch(/buttons: \[link\]/);
    expect(fn).toMatch(/buttons: partnerButtons/);
    expect(fn).toMatch(/to: \{ maxChatId: reach\.maxChatId, telegramChatId: reach\.telegramChatId \}/);
    expect(fn).toMatch(/reachForPartner\(params\.operatorId\)/);
  });

  it('отказ уведомлений не глушится пустым catch', () => {
    const block = ROUTE.slice(ROUTE.indexOf('notifyPartnerNewLeadPersonally({'), ROUTE.indexOf('void autoProcessLead'));
    expect(block).not.toMatch(/catch\(\(\) => undefined\)/);
    expect(block).toMatch(/console\.error/);
  });
});
