/**
 * Аргументы tools/call: строка JSON читается, пустота и «не объект» —
 * разные отказы (перепись журнала 08.10, prod-check run 98).
 *
 * Двенадцать отказов `invalid_args` у get_place_info, get_guardian_context,
 * get_tour_details и get_tour_availability — все с пустым главным аргументом,
 * то есть после разбора от аргументов не оставалось ничего. Роут превращал в
 * `{}` и строку с JSON: агент, передавший name строкой, слышал «нужно указать
 * name» и повторял тот же вызов.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({
  pool: { query, connect: vi.fn(async () => ({ query, release: vi.fn() })) },
}));

import { readToolArguments, argsRefusal } from '@/lib/mcp/tool-arguments';
import { POST } from '@/app/api/mcp/route';

describe('readToolArguments', () => {
  it('объект — как есть; отсутствие — пустой объект', () => {
    expect(readToolArguments({ name: 'Курильское озеро' })).toEqual({ args: { name: 'Курильское озеро' }, shape: 'object' });
    expect(readToolArguments(undefined)).toEqual({ args: {}, shape: 'absent' });
    expect(readToolArguments(null)).toEqual({ args: {}, shape: 'absent' });
  });

  it('строка с JSON-объектом читается как объект', () => {
    expect(readToolArguments('{"name":"Авачинский"}')).toEqual({ args: { name: 'Авачинский' }, shape: 'json_string' });
  });

  it('строка без объекта, массив, число — пустота с названной формой', () => {
    expect(readToolArguments('Авачинский')).toEqual({ args: {}, shape: 'string' });
    expect(readToolArguments('["Авачинский"]')).toEqual({ args: {}, shape: 'string' });
    expect(readToolArguments('null')).toEqual({ args: {}, shape: 'string' });
    expect(readToolArguments(['Авачинский'])).toEqual({ args: {}, shape: 'array' });
    expect(readToolArguments(46)).toEqual({ args: {}, shape: 'other' });
    expect(readToolArguments(true)).toEqual({ args: {}, shape: 'other' });
  });
});

describe('argsRefusal', () => {
  const schema = 'Аргументы для get_place_info не прошли проверку: нужно указать name (название места).';

  it('пустота — свой код и слова «не пришли»', () => {
    const r = argsRefusal({ args: {}, shape: 'absent' }, schema);
    expect(r.code).toBe('invalid_args:empty');
    expect(r.message).toMatch(/^Аргументы не пришли: объект arguments пуст\./);
    expect(r.message).toContain(schema);
  });

  it('не объект — код по форме, и сказано, что пришло', () => {
    expect(argsRefusal({ args: {}, shape: 'array' }, schema)).toMatchObject({ code: 'invalid_args:array' });
    expect(argsRefusal({ args: {}, shape: 'array' }, schema).message).toMatch(/пришли массивом/);
    expect(argsRefusal({ args: {}, shape: 'string' }, schema)).toMatchObject({ code: 'invalid_args:string' });
    expect(argsRefusal({ args: {}, shape: 'other' }, schema)).toMatchObject({ code: 'invalid_args:other' });
  });

  it('поля есть, но не те — прежний код и текст схемы без приставки', () => {
    expect(argsRefusal({ args: { phone: 'x' }, shape: 'object' }, schema)).toEqual({ message: schema, code: 'invalid_args' });
  });
});

// ── Роут: что слышит агент и что пишет журнал ────────────────────────────────

let ipSeq = 0;
async function call(name: string, args: unknown) {
  ipSeq += 1;
  const params: Record<string, unknown> = { name };
  if (args !== undefined) params.arguments = args;
  const res = await POST(new NextRequest('http://localhost/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': `10.9.0.${ipSeq}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }),
  }));
  const json = await res.json();
  return { result: json.result as { isError?: boolean; content: Array<{ text: string }> } };
}

/** Последняя запись журнала вызовов: [tool, ok, error_kind, …, error_code, arg_key, arg_value]. */
function lastJournal(): unknown[] {
  const rows = query.mock.calls.filter(([sql]) => typeof sql === 'string' && /INSERT INTO mcp_tool_calls/.test(sql));
  expect(rows.length).toBeGreaterThan(0);
  return rows[rows.length - 1][1] as unknown[];
}

let spy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  query.mockReset();
  query.mockImplementation(async () => ({ rows: [] }));
});
afterEach(() => spy.mockRestore());

describe('tools/call: аргументы строкой JSON доходят до исполнителя', () => {
  it('get_place_info с name в строке — ответ инструмента, а не «укажите name»', async () => {
    const { result } = await call('get_place_info', JSON.stringify({ name: 'Курильское озеро' }));
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).not.toMatch(/нужно указать name|не прошли проверку/);
    // Исполнитель искал именно это место: название дошло до SQL.
    expect(query.mock.calls.some(([, params]) => Array.isArray(params) && params.some((v) => typeof v === 'string' && v.includes('Курильское озеро')))).toBe(true);
    const j = lastJournal();
    expect(j[0]).toBe('get_place_info');
    expect(j[1]).toBe(true);
    expect(j[8]).toBe('name');
  });
});

describe('tools/call: пустота и «не объект» — разные отказы в журнале', () => {
  it('без arguments — «не пришли», код invalid_args:empty, ключа нет', async () => {
    const { result } = await call('get_tour_details', undefined);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Аргументы не пришли/);
    expect(result.content[0].text).toMatch(/нужно указать name/);
    const j = lastJournal();
    expect(j[2]).toBe('refused');
    expect(j[7]).toBe('invalid_args:empty');
    expect(j[8]).toBeNull();
  });

  it('пустой объект — тот же код', async () => {
    await call('get_guardian_context', {});
    expect(lastJournal()[7]).toBe('invalid_args:empty');
  });

  it('массив — код invalid_args:array и слова «пришли массивом»', async () => {
    const { result } = await call('get_tour_availability', ['46']);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/пришли массивом/);
    expect(result.content[0].text).toMatch(/нужно указать tour/);
    expect(lastJournal()[7]).toBe('invalid_args:array');
  });

  it('строка без объекта — invalid_args:string', async () => {
    await call('get_place_info', 'Авачинский');
    expect(lastJournal()[7]).toBe('invalid_args:string');
  });

  it('поля есть, но не те — прежний invalid_args и имя присланного поля', async () => {
    const { result } = await call('get_place_info', { phone_number: 'x' });
    expect(result.content[0].text).not.toMatch(/Аргументы не пришли/);
    const j = lastJournal();
    expect(j[7]).toBe('invalid_args');
    expect(j[8]).toBe('phone_number');
  });

  it('инструмент без обязательных полей с массивом работает, как работал', async () => {
    const { result } = await call('safety_status', []);
    expect(result.content[0].text).not.toMatch(/не прошли проверку|пришли массивом/);
    const j = lastJournal();
    expect(j[2]).not.toBe('refused');
    expect(String(j[7] ?? '')).not.toMatch(/^invalid_args/);
  });
});
