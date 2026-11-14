/**
 * Юани рядом с рублями в ответе MCP китайскому клиенту (владелец 14.11:
 * «если запрос из Китая, то пересчитывать по курсу ЦБ»).
 *
 * Судится то, что получает агент: текст ответа через настоящий обработчик
 * /api/mcp — и правило на граничных данных (CLAUDE.md §4).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { query, rate } = vi.hoisted(() => ({
  query: vi.fn(),
  rate: { value: null as null | { code: string; rubPerUnit: number; date: string } },
}));
vi.mock('@/lib/db-pool', () => ({ pool: { query, connect: async () => ({ query, release: () => {} }) } }));
vi.mock('@/lib/kuzmich/core', () => ({
  executeKuzmichTool: async () =>
    'ID70: "Восхождение на вулкан Горелый" от 15 000 ₽/чел. | ID46: "Ключевская" от 320 000 ₽/чел. (группа 6–15 чел.)',
}));
vi.mock('@/lib/currency/cbr-rate', async (orig) => ({
  ...(await orig<typeof import('@/lib/currency/cbr-rate')>()),
  loadCnyRate: async () => rate.value,
}));

import { POST } from '@/app/api/mcp/route';
import { wantsYuan, withYuan, yuanRateNote } from '@/lib/mcp/yuan-hint';

const RATE = { code: 'CNY', rubPerUnit: 11.051, date: '14.11.2026' };

describe('когда пересчитывать', () => {
  it('вопрос иероглифами или клиент из КНР — да; по-русски и по-английски с западным клиентом — нет', () => {
    expect(wantsYuan('zh', 'Mozilla/5.0')).toBe(true);
    expect(wantsYuan('ru', 'qwen-code/0.1.0')).toBe(true);
    expect(wantsYuan('en', 'Kimi-CLI/1.2')).toBe(true);
    expect(wantsYuan('ru', 'Mozilla/5.0')).toBe(false);
    expect(wantsYuan('en', 'claude-code/2.1')).toBe(false);
  });
});

describe('как пересчитывать', () => {
  it('«约 N 元» после рублей и единицы, рубли остаются; строка курса с датой и источником', () => {
    const out = withYuan('от 15 000 ₽/чел. и 320 000 ₽', RATE);
    expect(out).toContain('15 000 ₽/чел. (约 1,400 元)');
    expect(out).toContain('320 000 ₽ (约 29,000 元)');
    expect(out).toContain('2026-11-14');
    expect(out).toContain('cbr.ru');
    expect(out).toContain('以卢布计价');
  });

  it('неразрывный пробел в разрядах тоже читается', () => {
    expect(withYuan('85 000 ₽', RATE)).toContain('85 000 ₽ (约 7,700 元)');
  });

  it('рублей в ответе нет — ответ не меняется', () => {
    expect(withYuan('Обстановка в крае: предупреждений нет.', RATE)).toBe('Обстановка в крае: предупреждений нет.');
  });

  it('курс не прочитался — рубли как есть и строка «курс не прочитан», без выдуманных юаней', () => {
    const out = withYuan('от 15 000 ₽/чел.', null);
    expect(out.startsWith('от 15 000 ₽/чел.')).toBe(true);
    expect(out).not.toContain('约');
    expect(out).toBe('от 15 000 ₽/чел.' + yuanRateNote(null));
  });
});

let ip = 0;
async function getTours(args: Record<string, unknown>, ua = 'Mozilla/5.0') {
  ip += 1;
  const res = await POST(new NextRequest('http://localhost/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': ua, 'x-real-ip': `10.12.${Math.floor(ip / 250)}.${ip % 250}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_tours', arguments: args } }),
  }));
  return ((await res.json()).result as { content: Array<{ text: string }> }).content[0]!.text;
}

describe('ответ /api/mcp', () => {
  beforeEach(() => {
    process.env.MCP_HASH_SALT = 'соль-для-теста';
    rate.value = RATE;
    query.mockReset().mockImplementation(async (sql: string) =>
      (/COUNT\(\*\)/.test(sql) ? { rows: [{ a: '0', b: '0', c: '0' }] } : { rows: [] }));
  });

  it('вопрос по-китайски — юани по курсу ЦБ', async () => {
    const text = await getTours({ activity_type: '火山' });
    expect(text).toContain('15 000 ₽/чел. (约 1,400 元)');
    expect(text).toContain('1 元 = 11.051 卢布');
  });

  it('китайский клиент с вопросом по-русски — тоже юани', async () => {
    const text = await getTours({ activity_type: 'вулканы' }, 'qwen-code/0.1.0');
    expect(text).toContain('约 1,400 元');
  });

  it('вопрос по-русски от обычного клиента — только рубли', async () => {
    const text = await getTours({ activity_type: 'вулканы' });
    expect(text).toContain('15 000 ₽/чел.');
    expect(text).not.toContain('元');
  });
});
