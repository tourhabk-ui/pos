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
 *  - кнопка одна и это ссылка: действие (payload) бот принимает лишь из
 *    рабочего чата платформы, в личном чате оно было бы мёртвым;
 *  - исходов четыре: доставлено / заглушка / нет канала / адрес не прочитался
 *    — «не смог» не выдаётся за «доставлено»;
 *  - рабочий чат видит, дошло ли до оператора лично и кого привязывать;
 *  - роут /api/leads зовёт личную доставку, а slug страницы оператора
 *    резолвится по публичности карточки, не только по включённому виджету.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { reachMock, pdMock } = vi.hoisted(() => ({ reachMock: vi.fn(), pdMock: vi.fn() }));
vi.mock('@/lib/partners/reach', () => ({ reachForPartner: reachMock }));
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
});

describe('notifyPartnerNewLeadPersonally — адрес оператора, ПД только в MAX', () => {
  it('привязанный оператор: ПД в его MAX, заглушка без ПД, кнопка — только ссылка в кабинет', async () => {
    reachMock.mockResolvedValue(BOUND);
    const outcome = await notifyPartnerNewLeadPersonally({ ...LEAD, origin: 'форма на вашей странице на Ведаре', sourceUrl: 'https://vedarai.ru/mestechko' });
    expect(outcome).toEqual({ state: 'delivered', channel: 'max' });
    expect(reachMock).toHaveBeenCalledWith('op-mestechko');
    expect(pdMock).toHaveBeenCalledTimes(1);
    const args = lastPdArgs();
    expect(args.to).toEqual({ maxChatId: '111', telegramChatId: '222' });
    expect(args.text).toContain('Анна');
    expect(args.text).toContain('+79990000000');
    expect(args.text).toContain('Толбачик');
    expect(args.stub).not.toContain('Анна');
    expect(args.stub).not.toContain('+79990000000');
    expect(args.stub).toContain('lead-1');
    expect(args.text).toContain('форма на вашей странице на Ведаре');
    expect(args.stub).toContain('https://vedarai.ru/mestechko');
    expect(args.buttons).toHaveLength(1);
    expect(args.buttons?.[0].url).toBe('https://vedarai.ru/hub/operator/leads/lead-1');
    expect(args.buttons?.some((b) => 'payload' in b)).toBe(false);
  });

  it('оператор не привязан → no_channel, ничего не шлётся', async () => {
    reachMock.mockResolvedValue({ maxChatId: null, telegramChatId: null, telegramSource: null, reachable: false });
    expect(await notifyPartnerNewLeadPersonally(LEAD)).toEqual({ state: 'no_channel' });
    expect(pdMock).not.toHaveBeenCalled();
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

  it('в личном уведомлении нет кнопок-действий — в личном чате бот их не принимает', () => {
    const fn = NOTIFY.slice(NOTIFY.indexOf('export async function notifyPartnerNewLeadPersonally'));
    expect(fn).toMatch(/to: \{ maxChatId: reach\.maxChatId, telegramChatId: reach\.telegramChatId \}/);
    expect(fn).not.toMatch(/payload:/);
    expect(fn).toMatch(/reachForPartner\(params\.operatorId\)/);
  });

  it('отказ уведомлений не глушится пустым catch', () => {
    const block = ROUTE.slice(ROUTE.indexOf('notifyPartnerNewLeadPersonally({'), ROUTE.indexOf('void autoProcessLead'));
    expect(block).not.toMatch(/catch\(\(\) => undefined\)/);
    expect(block).toMatch(/console\.error/);
  });
});
