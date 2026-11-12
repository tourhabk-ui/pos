// @vitest-environment node
/**
 * /approve_<id> и /reject_<id> владельца в Telegram (находка C3 проверки CRM
 * и каналов 25.10, перепроверена 11.11).
 *
 * Команда не срабатывала ни разу: поиск по началу id шёл `id LIKE $1` при
 * `id UUID` — PostgreSQL 16 отвечает 42883 «operator does not exist: uuid ~~
 * unknown»; а /reject_ писал execution_status 'rejected', которого CHECK
 * миграции 066 не допускает (23514). Оба SQL проверены на настоящем
 * PostgreSQL 16 при правке: прежние падают, новые — UPDATE 1, повтор — UPDATE 0.
 *
 * Сторож — вызовом runApprovalCommand с подменённой базой: что ушло в базу и
 * что ответили владельцу.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { q } = vi.hoisted(() => ({ q: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => q(...a) } }));

import {
  runApprovalCommand, parseApprovalCommand, APPROVAL_LOOKUP_SQL, APPROVAL_DECIDE_SQL,
} from '@/lib/agents/safeguards/approval-command';

const ID = '1a2b3c4d-0000-4000-8000-000000000001';
const ROW = { id: ID, description: 'Черновик тура <b>Тест</b>', action_type: 'tour_draft' };

let replies: string[];
const reply = async (t: string) => { replies.push(t); };

beforeEach(() => {
  replies = [];
  q.mockReset();
});

describe('разбор команды', () => {
  it('одобрение и отказ, начало id в нижнем регистре', () => {
    expect(parseApprovalCommand('/approve_1A2B3C4D')).toEqual({ approve: true, prefix: '1a2b3c4d' });
    expect(parseApprovalCommand('/reject_1a2b3c4d')).toEqual({ approve: false, prefix: '1a2b3c4d' });
  });
  it('не id или слишком короткий — не команда, в базу не ходим', async () => {
    expect(parseApprovalCommand('/approve_%')).toBeNull();
    expect(parseApprovalCommand('/approve_abc')).toBeNull();
    await runApprovalCommand('/approve_%_', reply);
    expect(q).not.toHaveBeenCalled();
    expect(replies[0]).toMatch(/Неверный формат/);
  });
});

describe('SQL', () => {
  it('поиск приводит uuid к тексту и берёт только ждущие', () => {
    expect(APPROVAL_LOOKUP_SQL).toMatch(/id::text LIKE \$1/);
    expect(APPROVAL_LOOKUP_SQL).toMatch(/status = 'pending'/);
  });
  it('решение — только по ждущему', () => {
    expect(APPROVAL_DECIDE_SQL).toMatch(/WHERE id = \$4 AND status = 'pending'/);
  });
});

describe('выполнение', () => {
  it('одобрение: поиск по началу id, запись assigned, ответ с типом', async () => {
    q.mockResolvedValueOnce({ rows: [ROW] }).mockResolvedValueOnce({ rowCount: 1 });
    await runApprovalCommand('/approve_1a2b3c4d', reply);
    expect(q.mock.calls[0]![1]).toEqual(['1a2b3c4d%']);
    expect(q.mock.calls[1]![1]).toEqual(['approved', 'assigned', 'Approved via Telegram bot', ID]);
    expect(replies[0]).toMatch(/Одобрено/);
    expect(replies[0]).toContain('&lt;b&gt;Тест&lt;/b&gt;');
  });

  it('отказ пишет execution_status NULL, а не вне CHECK', async () => {
    q.mockResolvedValueOnce({ rows: [ROW] }).mockResolvedValueOnce({ rowCount: 1 });
    await runApprovalCommand('/reject_1a2b3c4d', reply);
    expect(q.mock.calls[1]![1]).toEqual(['rejected', null, 'Rejected via Telegram bot', ID]);
    expect(replies[0]).toMatch(/Отклонено/);
  });

  it('не найдено, несколько совпадений, уже решено — каждое своими словами', async () => {
    q.mockResolvedValueOnce({ rows: [] });
    await runApprovalCommand('/approve_1a2b3c4d', reply);
    q.mockResolvedValueOnce({ rows: [ROW, { ...ROW, id: '1a2b3c4d-9' }] });
    await runApprovalCommand('/approve_1a2b3c4d', reply);
    q.mockResolvedValueOnce({ rows: [ROW] }).mockResolvedValueOnce({ rowCount: 0 });
    await runApprovalCommand('/approve_1a2b3c4d', reply);
    expect(replies[0]).toMatch(/не найден/);
    expect(replies[1]).toMatch(/нескольким/);
    expect(replies[2]).toMatch(/уже решён/);
  });

  it('отказ базы — в лог с именем проверки, владельцу — без текста исключения', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    q.mockRejectedValueOnce(Object.assign(new Error('operator does not exist: uuid ~~ unknown'), { code: '42883' }));
    await runApprovalCommand('/approve_1a2b3c4d', reply);
    expect(replies[0]).toMatch(/база не ответила/);
    expect(replies[0]).not.toMatch(/operator does not exist/);
    expect(spy.mock.calls.some((c) => String(c[0]).includes('[approval-command]'))).toBe(true);
    spy.mockRestore();
  });
});
