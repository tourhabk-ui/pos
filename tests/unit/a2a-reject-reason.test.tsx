// @vitest-environment jsdom
/**
 * Причина отказа задаче A2A — от инструмента до страницы журнала (слово
 * владельца 13.11: заявки агентов «отклонены по причине нет согласия
 * человека… может, согласие не доходит? нужна проверка»).
 *
 * Журнал запросов A2A знал только «отказ», а подпись под таблицей перечисляла
 * четыре возможные причины разом. Здесь держится вся дорога кода причины:
 *   инструмент (`refused.code`) → `metadata.reason` задачи → факты ответа →
 *   строка журнала → слова в админке.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query } }));

import { safeRejectCode, rejectReasonLabel, REJECT_CODE_MAX } from '@/lib/a2a/reject-reason';
import { handleA2A, type A2AExecutors } from '@/lib/a2a/handle';
import { memoryTaskStore } from '@/lib/a2a/task-store';
import { sendMessageFacts, logA2aRequest } from '@/lib/a2a/journal';
import type { PublicToolOutcome } from '@/lib/mcp/tool-outcome';
import { RequestOutcome, RejectReasons } from '@/app/hub/admin/a2a/_RejectReasons';

beforeEach(() => {
  process.env.MCP_HASH_SALT = 'соль-для-теста';
  query.mockReset().mockResolvedValue({ rows: [] });
});

describe('код причины: что годится в журнал', () => {
  it('свои коды проходят как есть', () => {
    for (const code of ['no_consent', 'bad_phone', 'implausible_phone', 'write_guard', 'rate_limited', 'unknown_tool', 'invalid_args:tour', 'invalid_args:date_from', 'key_not_found', 'refused']) {
      expect(safeRejectCode(code)).toBe(code);
    }
  });

  it('пусто — причины нет; текст, чужие знаки и длинное — other, а не обрезок', () => {
    expect([safeRejectCode(null), safeRejectCode(undefined), safeRejectCode(''), safeRejectCode('  '), safeRejectCode(42)]).toEqual([null, null, null, null, null]);
    for (const raw of [
      'Нет согласия на обработку', 'no consent', 'NO_CONSENT', 'invalid_args:Tour', 'a:b:c', '+79001234567',
      'ivan@example.com', 'invalid_args:' + 'x'.repeat(30), 'x'.repeat(REJECT_CODE_MAX + 5), "no_consent'; DROP TABLE",
    ]) expect([raw, safeRejectCode(raw)]).toEqual([raw, 'other']);
  });

  it('слова причины: своя строка, поле у invalid_args, незнакомый код — как есть, пусто — «не записана»', () => {
    expect(rejectReasonLabel('no_consent')).toBe('нет согласия человека на обработку данных');
    expect(rejectReasonLabel('invalid_args:tour')).toBe('не то в поле tour');
    expect(rejectReasonLabel('invalid_args')).toBe('не те поля запроса');
    expect(rejectReasonLabel('tour_lookup_failed')).toBe('данные не прочитались — сбой у нас');
    expect(rejectReasonLabel('date_closed_by_platform')).toBe('date_closed_by_platform');
    expect([rejectReasonLabel(null), rejectReasonLabel(undefined), rejectReasonLabel('')]).toEqual(['причина не записана', 'причина не записана', 'причина не записана']);
  });
});

describe('причина идёт от инструмента до журнала', () => {
  let n = 0;
  const ctx = (version: '1.0' | '0.3') => ({ version, now: () => 1_760_000_000_000, newId: () => `id-${++n}` });
  const deps = (outcome: PublicToolOutcome, chat: Awaited<ReturnType<A2AExecutors['chat']>> = { ok: true, text: 'ответ' }) => ({
    executors: { runTool: vi.fn(async () => outcome), chat: vi.fn(async () => chat) } as A2AExecutors,
    store: memoryTaskStore(),
  });
  const tool = { message: { messageId: 'm', parts: [{ data: { tool: 'create_booking_request', arguments: { tour: '27' } } }] } };
  const text = { message: { messageId: 'm', parts: [{ text: 'Какая погода?' }] } };

  async function facts(outcome: PublicToolOutcome, version: '1.0' | '0.3' = '1.0') {
    const out = await handleA2A('SendMessage', tool, ctx(version), deps(outcome));
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error('не ответил');
    return sendMessageFacts(out.result);
  }

  it.each(['1.0', '0.3'] as const)('версия %s: код отказа инструмента — в фактах ответа', async (version) => {
    expect(await facts({ kind: 'refused', text: 'нет согласия', code: 'no_consent' }, version))
      .toMatchObject({ state: 'rejected', input: 'tool', tool: 'create_booking_request', reason: 'no_consent' });
    expect((await facts({ kind: 'refused', text: 'поле', code: 'invalid_args:tour' }, version)).reason).toBe('invalid_args:tour');
  });

  it('отказ без кода — refused; лимит и неизвестный инструмент — свои коды', async () => {
    expect((await facts({ kind: 'refused', text: 'отказ' })).reason).toBe('refused');
    expect((await facts({ kind: 'rate_limited', text: 'подождите' })).reason).toBe('rate_limited');
    expect((await facts({ kind: 'unknown_tool', message: 'нет такого', data: { available: [], suggestion: null } })).reason).toBe('unknown_tool');
  });

  it('у выполненной и у упавшей задачи причины отказа нет', async () => {
    expect((await facts({ kind: 'ok', text: 'готово', handoffUrl: null })).reason).toBeNull();
    expect((await facts({ kind: 'failed', text: 'сбой' })).reason).toBeNull();
  });

  it('текстовый вопрос: отказ один — лимит на адрес; ответ и сбой причины не несут', async () => {
    const run = async (chat: Awaited<ReturnType<A2AExecutors['chat']>>) => {
      const out = await handleA2A('SendMessage', text, ctx('1.0'), deps({ kind: 'ok', text: '', handoffUrl: null }, chat));
      if (!out.ok) throw new Error('не ответил');
      return sendMessageFacts(out.result);
    };
    expect(await run({ ok: false, text: 'лимит', rejected: true })).toMatchObject({ state: 'rejected', input: 'text', reason: 'rate_limited' });
    expect((await run({ ok: true, text: 'ответ' })).reason).toBeNull();
    expect(await run({ ok: false, text: 'сбой' })).toMatchObject({ state: 'failed', reason: null });
  });

  it('агент видит код в metadata задачи — и только код, без текста', async () => {
    const out = await handleA2A('SendMessage', tool, ctx('1.0'), deps({ kind: 'refused', text: 'Заявка не создана', code: 'bad_phone' }));
    if (!out.ok) throw new Error('не ответил');
    expect((out.result.task as { metadata: unknown }).metadata).toEqual({ input: 'tool', tool: 'create_booking_request', reason: 'bad_phone' });
  });

  it('в metadata задачи код проходит ту же проверку вида: текст вместо кода агенту не уходит', async () => {
    // Сегодня инструменты называют причину литералом, и текста здесь быть не
    // может. Проверка держит это и для будущего инструмента (замечание ревью 13.11).
    for (const code of ['Иван, +79001234567', 'нет согласия', 'no consent given', 'A'.repeat(60)]) {
      const out = await handleA2A('SendMessage', tool, ctx('1.0'), deps({ kind: 'refused', text: 'Заявка не создана', code }));
      if (!out.ok) throw new Error('не ответил');
      expect((out.result.task as { metadata: unknown }).metadata).toEqual({ input: 'tool', tool: 'create_booking_request', reason: 'other' });
    }
    // Пустой код — как отсутствующий: «отказ без названной причины».
    const blank = await handleA2A('SendMessage', tool, ctx('1.0'), deps({ kind: 'refused', text: 'Заявка не создана', code: '  ' }));
    if (!blank.ok) throw new Error('не ответил');
    expect((blank.result.task as { metadata: { reason: string } }).metadata.reason).toBe('refused');
  });

  it('в факты не попадает то, что кодом не является: metadata с текстом даёт other', () => {
    const forged = { task: { status: { state: 'TASK_STATE_REJECTED' }, metadata: { input: 'tool', tool: 'create_lead', reason: 'Иван, +79001234567' } } };
    expect(sendMessageFacts(forged).reason).toBe('other');
  });

  it('причина читается только у отклонённой задачи: у выполненной с тем же полем — нет', () => {
    const done = { task: { status: { state: 'TASK_STATE_COMPLETED' }, metadata: { input: 'tool', tool: 'create_lead', reason: 'no_consent' } } };
    expect(sendMessageFacts(done).reason).toBeNull();
    const failed = { kind: 'task', status: { state: 'failed' }, metadata: { input: 'tool', tool: 'create_lead', reason: 'no_consent' } };
    expect(sendMessageFacts(failed).reason).toBeNull();
  });
});

describe('строка журнала', () => {
  const last = () => (query.mock.calls.at(-1)?.[1] ?? []) as unknown[];
  const base = { binding: 'jsonrpc' as const, op: 'SendMessage' as const, version: '1.0', versionDeclared: true, ok: true, input: 'tool' as const, tool: 'create_booking_request', ip: '10.0.0.1', userAgent: 'agent/1', self: false };

  it('причина пишется у отклонённой задачи и только у неё', () => {
    logA2aRequest({ ...base, state: 'rejected', rejectCode: 'no_consent' });
    expect(last()[16]).toBe('no_consent');
    logA2aRequest({ ...base, state: 'completed', rejectCode: 'no_consent' });
    expect(last()[16]).toBeNull();
    logA2aRequest({ ...base, state: 'failed', rejectCode: 'no_consent' });
    expect(last()[16]).toBeNull();
    logA2aRequest({ ...base, state: 'rejected' });
    expect(last()[16]).toBeNull();
  });

  it('в колонку идёт код, а не то, что прислали вместо него', () => {
    logA2aRequest({ ...base, state: 'rejected', rejectCode: 'Иван Петров +79001234567' });
    expect(last()[16]).toBe('other');
    expect(JSON.stringify(last())).not.toContain('79001234567');
  });
});

describe('страница журнала называет причину словами', () => {
  const row = (over: Record<string, unknown>) => ({ ok: true, state: 'rejected', error_code: null, method: null, reject_code: null, reject_label: null, ...over });

  it('отказ с причиной: слова и код', () => {
    render(<RequestOutcome r={row({ reject_code: 'no_consent', reject_label: 'нет согласия человека на обработку данных' })} />);
    expect(screen.getByText(/отказ: нет согласия человека на обработку данных/)).toBeTruthy();
    expect(screen.getByText('no_consent')).toBeTruthy();
  });

  it('отказ, записанный до 13.11: «причина не записана», а не догадка', () => {
    render(<RequestOutcome r={row({})} />);
    expect(screen.getByText(/отказ: причина не записана/)).toBeTruthy();
  });

  it('выполнено, сбой и ошибка протокола — прежними словами, без слова «отказ»', () => {
    const { rerender, container } = render(<RequestOutcome r={row({ state: 'completed' })} />);
    expect(container.textContent).toBe('выполнено');
    rerender(<RequestOutcome r={row({ state: 'failed' })} />);
    expect(container.textContent).toBe('сбой');
    rerender(<RequestOutcome r={row({ state: null })} />);
    expect(container.textContent).toBe('ответ');
    rerender(<RequestOutcome r={row({ ok: false, state: null, error_code: 'MethodNotFound', method: 'tools/list' })} />);
    expect(container.textContent).toBe('ошибка: MethodNotFound · tools/list');
  });

  it('сводка: причина, инструмент и счёт по строкам; отказ текстовому вопросу назван так', () => {
    render(
      <RejectReasons
        days={7}
        rows={[
          { code: 'no_consent', label: 'нет согласия человека на обработку данных', tool: 'create_booking_request', tasks: 2, agents: 1 },
          { code: 'rate_limited', label: 'слишком много запросов с адреса', tool: null, tasks: 5, agents: 3 },
        ]}
      />,
    );
    expect(screen.getByText('Отказы по причинам (за 7 дн.)')).toBeTruthy();
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText(/нет согласия человека/)).toBeTruthy();
    expect(within(rows[0]).getByText('create_booking_request')).toBeTruthy();
    expect(within(rows[0]).getByText('2')).toBeTruthy();
    expect(within(rows[1]).getByText('текстовый вопрос')).toBeTruthy();
    expect(within(rows[1]).getByText('5')).toBeTruthy();
    expect(screen.queryByText(/записаны до 13\.11/)).toBeNull();
  });

  it('сводка: отказы без записанной причины посчитаны и объяснены; пусто — сказано, что отказов не было', () => {
    const { unmount } = render(
      <RejectReasons days={30} rows={[{ code: null, label: 'причина не записана', tool: 'create_lead', tasks: 3, agents: 2 }, { code: null, label: 'причина не записана', tool: null, tasks: 1, agents: 1 }]} />,
    );
    expect(screen.getByText(/«Причина не записана» — 4: эти отказы записаны до 13\.11/)).toBeTruthy();
    unmount();
    render(<RejectReasons days={30} rows={[]} />);
    expect(screen.getByText('За окно ни одна задача не отклонена.')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('/hub/admin/a2a целиком: причина видна там, где владелец смотрит журнал', () => {
  it('блок «Отказы по причинам» и причина в строке запроса; подпись больше не перечисляет причины наугад', async () => {
    const agent = { agent: 'DeerFlow', ua_family: 'other', region: null, is_self: false, kind: 'external', requests: 3, sends: 3, text_sends: 0, tool_sends: 3, completed: 1, rejected: 2, failed: 0, protocol_errors: 0, card_reads: 0, dialogs: 1, caller_days: 1, versions: ['1.0'], bindings: ['jsonrpc'], first_seen: '2026-11-13 08:00', last_seen: '2026-11-13 08:05' };
    const recent = { at: '2026-11-13 20:05:00', binding: 'jsonrpc', op: 'SendMessage', version: '1.0', version_declared: true, ok: true, error_code: null, method: null, input: 'tool', tool: 'create_booking_request', duration_ms: 40, agent: 'DeerFlow', ua_family: 'other', is_self: false, kind: 'external' };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({
      success: true, window_days: 7, generated_at: '2026-11-13T11:00:00Z',
      a2a: {
        ok: true, since: '2026-10-12', total_all_time: 3, total_window: 3, recent_limit: 50, by_day: [], by_tool: [], by_agent: [agent],
        by_reason: [{ code: 'no_consent', label: 'нет согласия человека на обработку данных', tool: 'create_booking_request', tasks: 2, agents: 1 }],
        recent: [
          { ...recent, state: 'rejected', reject_code: 'no_consent', reject_label: 'нет согласия человека на обработку данных' },
          { ...recent, at: '2026-11-13 20:01:00', state: 'completed', reject_code: null, reject_label: null },
        ],
      },
      mcp: { ok: true, clients: [] },
      entries: { ok: true, since: null, total_all_time: 0, total_window: 0, by_family: [] },
      dialogs: { ok: true, since: null, total: 0, retention_days: 90, limit: 50, items: [] },
      degraded: [], note: '',
    }) })));
    try {
      const { default: A2aClient } = await import('@/app/hub/admin/a2a/_A2aClient');
      render(<A2aClient />);
      expect(await screen.findByText('Отказы по причинам (за 7 дн.)')).toBeTruthy();
      expect(screen.getByText(/отказ: нет согласия человека на обработку данных/)).toBeTruthy();
      expect(screen.getAllByText(/нет согласия человека на обработку данных/)).toHaveLength(2);
      expect(screen.getByText('выполнено')).toBeTruthy();
      // Прежняя подпись называла четыре причины разом — по ней нельзя было понять, какая перед глазами.
      expect(document.body.textContent).not.toMatch(/нет согласия, нет мест,\s+лимит/);
      expect(document.body.textContent).toMatch(/отчего именно — в блоке\s+«Отказы по причинам»/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
