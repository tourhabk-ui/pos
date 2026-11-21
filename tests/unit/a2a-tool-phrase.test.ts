// @vitest-environment node
/**
 * Вопрос словами в поле `tool` DataPart (21.11, слово владельца «го
 * карт-бланш»): A2A отвечает на него как на TextPart — разговором, а не
 * отказом. Род («фраза», «не латиница») — в metadata задачи и в журнал A2A,
 * текст — нет. Живое имя и алиас по-прежнему вызывают инструмент; неизвестное
 * имя-идентификатор (пробы) — отказ. MCP tools/call не меняется.
 */
import { describe, it, expect, vi } from 'vitest';
import { handleA2A, readToolPhrase, type A2AExecutors } from '@/lib/a2a/handle';
import { memoryTaskStore } from '@/lib/a2a/task-store';
import { sendMessageFacts } from '@/lib/a2a/journal';
import { toolNameIsQuestion, unknownToolResponse } from '@/lib/mcp/unknown-tool';
import { requestedToolColumn } from '@/lib/mcp/call-log';
import type { PublicToolOutcome } from '@/lib/mcp/tool-outcome';

function deps(toolOutcome: PublicToolOutcome = { kind: 'unknown_tool', message: 'Нет такого', data: { available: [], suggestion: null } }) {
  const executors: A2AExecutors = {
    runTool: vi.fn(async () => toolOutcome),
    chat: vi.fn(async () => ({ ok: true as const, text: 'Кузьмич отвечает' })),
  };
  return { executors, store: memoryTaskStore() };
}
let n = 0;
const ctx = () => ({ version: '1.0' as const, now: () => 1_760_000_000_000, newId: () => `id-${++n}` });
const msg = (parts: unknown[]) => ({ message: { messageId: 'm', parts } });

describe('toolNameIsQuestion', () => {
  it('фраза и не латиница — вопрос; имя, алиас, проба, пустота — нет', () => {
    expect(toolNameIsQuestion('какие туры на вулканы в августе?')).toBe(true);
    expect(toolNameIsQuestion('find tours in August')).toBe(true);
    expect(toolNameIsQuestion('查询堪察加旅游')).toBe(true);
    for (const s of ['get_tours', 'Get Tours', 'vedar:get_tours', 'evyai_mcp_check_probe', 'no_such_tool', '', '   ']) {
      expect(toolNameIsQuestion(s), s).toBe(false);
    }
  });
});

describe('A2A: вопрос в поле tool — разговор, а не отказ', () => {
  it('фраза → chat с текстом целиком, completed, род «фраза» в metadata и в журнале; инструмент не зовётся', async () => {
    const q = 'Какие туры на вулканы есть в августе и сколько дней они длятся, если нас четверо взрослых?';
    expect(q.length).toBeGreaterThan(80);
    const d = deps();
    const out = await handleA2A('SendMessage', msg([{ data: { tool: q, arguments: {} } }]), ctx(), d);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(d.executors.runTool).not.toHaveBeenCalled();
    expect(d.executors.chat).toHaveBeenCalledWith(q, expect.anything(), expect.anything());
    const task = out.result.task as { status: { state: string }; metadata: Record<string, unknown> };
    expect(task.status.state).toBe('TASK_STATE_COMPLETED');
    expect(task.metadata).toEqual({ input: 'text', tool_kind: 'фраза' });
    const facts = sendMessageFacts(out.result);
    expect(facts).toMatchObject({ input: 'text', tool: 'не-идентификатор: фраза', state: 'completed' });
    expect(JSON.stringify(facts)).not.toContain('вулканы');
  });

  it('иероглифы без пробелов — тоже вопрос, род «не латиница»', async () => {
    const d = deps();
    const out = await handleA2A('SendMessage', msg([{ data: { tool: '堪察加八月有什么火山旅游' } }]), ctx(), d);
    expect(out.ok && sendMessageFacts(out.result).tool).toBe('не-идентификатор: не латиница');
    expect(d.executors.chat).toHaveBeenCalledTimes(1);
  });

  it('фраза рядом с TextPart — оба текста одним вопросом, без повтора', async () => {
    const d = deps();
    await handleA2A('SendMessage', msg([{ data: { tool: 'find tours' } }, { text: 'in August, 4 people' }]), ctx(), d);
    expect(d.executors.chat).toHaveBeenCalledWith('find tours\nin August, 4 people', expect.anything(), expect.anything());
    const d2 = deps();
    await handleA2A('SendMessage', msg([{ data: { tool: 'find tours' } }, { text: 'find tours' }]), ctx(), d2);
    expect(d2.executors.chat).toHaveBeenCalledWith('find tours', expect.anything(), expect.anything());
  });

  it('имя-идентификатор (проба) — по-прежнему инструмент и отказ, не разговор', async () => {
    const d = deps();
    const out = await handleA2A('SendMessage', msg([{ data: { tool: 'evyai_mcp_check_probe' } }]), ctx(), d);
    expect(d.executors.runTool).toHaveBeenCalledWith('evyai_mcp_check_probe', {});
    expect(d.executors.chat).not.toHaveBeenCalled();
    expect(out.ok && (out.result.task as { status: { state: string } }).status.state).toBe('TASK_STATE_REJECTED');
  });

  it('алиас («Get Tours») — инструмент, а не разговор', async () => {
    const d = deps({ kind: 'ok', text: 'Туры', handoffUrl: null });
    await handleA2A('SendMessage', msg([{ data: { tool: 'Get Tours' } }]), ctx(), d);
    expect(d.executors.runTool).toHaveBeenCalledWith('Get Tours', {});
    expect(d.executors.chat).not.toHaveBeenCalled();
    expect(readToolPhrase([{ kind: 'data', data: { tool: 'Get Tours' } }] as never)).toBeNull();
  });

  it('MCP не меняется: на фразу — отказ с подсказкой', () => {
    expect(unknownToolResponse('find tours in August').message).toMatch(/^Unknown tool: find tours in August\..*not a phrase/);
  });
});

describe('журнал: род алиаса без текста', () => {
  it('requested_tool — имя при unknown_tool, род алиаса у остальных, иначе null', () => {
    expect(requestedToolColumn({ errorKind: 'unknown_tool', requestedTool: 'get_tour' })).toBe('get_tour');
    expect(requestedToolColumn({ aliasKind: 'префикс' })).toBe('алиас: префикс');
    expect(requestedToolColumn({ errorKind: 'refused', aliasKind: 'написание' })).toBe('алиас: написание');
    expect(requestedToolColumn({})).toBeNull();
    expect(requestedToolColumn({ aliasKind: null })).toBeNull();
  });
});
