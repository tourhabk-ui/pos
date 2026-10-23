// @vitest-environment node
/**
 * Пауза проката на сайте и агенты — слово владельца 23.10: «пока прячем прокат
 * лагуны до понедельника но оставляем его для mcp и A2A» (lib/rental/site-pause).
 *
 * Чат Кузьмича (сайт, виджет, Telegram, MAX) — люди: пока пауза идёт, прайс
 * «Лагуны» им не называется, и ответ говорит, когда прокат вернётся, а не
 * «проката нет». MCP (`search_car_rental`, поверхность `mcp`) и A2A — прямой
 * вызов тем же путём, что MCP, и свободный вопрос агента через цикл Кузьмича —
 * получают прайс целиком. Судится вызовом настоящего цикла инструментов с
 * подменённой моделью: модель просит search_car_rental, и проверяется, что
 * инструмент вернул ей в каждом случае. Часы — подложенные.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { waterfall, loadCompanies } = vi.hoisted(() => ({ waterfall: vi.fn(), loadCompanies: vi.fn() }));
vi.mock('@/lib/ai/providers', async (orig) => ({
  ...(await orig<typeof import('@/lib/ai/providers')>()),
  callToolsWaterfall: (...a: unknown[]) => waterfall(...a),
}));
vi.mock('@/lib/rental/rental', async (orig) => ({
  ...(await orig<typeof import('@/lib/rental/rental')>()),
  loadRentalCompanies: () => loadCompanies(),
}));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn().mockResolvedValue({ rows: [] }) } }));
vi.mock('@/lib/ai/rag-context', () => ({ buildRAGContext: vi.fn().mockResolvedValue('') }));
vi.mock('@/lib/kuzmich/safety-review-log', () => ({ recordSafetyReview: vi.fn() }));
vi.mock('@/lib/config', async (orig) => ({
  ...(await orig<typeof import('@/lib/config')>()),
  getPublicBaseUrl: () => 'https://vedarai.ru',
}));

import { aiChatAgentLoop, executeKuzmichTool } from '@/lib/kuzmich/core';
import { answerAgentMessage } from '@/lib/a2a/chat';
import { searchCarRentalForKuzmich } from '@/lib/kuzmich/car-rental-search';
import type { ToolRun } from '@/lib/agents/eval/grounding';
import type { RentalCompany } from '@/lib/rental/rental-format';

const DURING = new Date('2026-10-23T00:00:00Z');
const AFTER = new Date('2026-10-26T12:00:00Z');

const LAGUNA: RentalCompany = {
  partnerId: 'p-lp', slug: 'laguna-prokat', name: 'Лагуна Прокат', shortDescription: null, logo: null, photos: [],
  phone: '+79140000000', telegramHref: null,
  offers: [{
    id: 'o1', title: 'Suzuki Jimny', bodyKind: 'suv', seats: 4, transmission: 'automatic', drive: '4wd', engineHp: 105,
    priceRubPerDay: 7000, priceIsFrom: false, depositRub: 15000, driver: 'self', conditions: null, sourceUrl: null, pricesSeenOn: null, photo: null,
  }],
};
const BAY: RentalCompany = { ...LAGUNA, partnerId: 'p-bay', slug: 'bay-rental', name: 'Бухта Прокат' };

/** Модель: первым ходом просит прайс проката, вторым — отвечает. */
function modelAsksRental(): void {
  waterfall.mockReset();
  waterfall
    .mockResolvedValueOnce({
      content: '',
      provider: 'test',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_car_rental', arguments: '{"query":"джип"}' } }],
    })
    .mockResolvedValueOnce({ content: 'Готово.', provider: 'test' });
}

/** Что инструмент проката вернул модели во втором ходе. */
function rentalToolOutput(): string {
  const msgs = waterfall.mock.calls[1]?.[0] as Array<{ role: string; content: string | null }> | undefined;
  const tool = msgs?.find((m) => m.role === 'tool');
  return tool?.content ?? '';
}

function at(moment: Date): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(moment);
}

beforeEach(() => {
  loadCompanies.mockReset();
  loadCompanies.mockResolvedValue([LAGUNA]);
});
afterEach(() => { vi.useRealTimers(); });

describe('чат Кузьмича — люди на сайте: в паузу прайса «Лагуны» нет', () => {
  it('цикл чата: инструмент отвечает «вернётся во вторник», без машин, цен и адреса прокатчика', async () => {
    at(DURING);
    modelAsksRental();
    const runs: ToolRun[] = [];
    await aiChatAgentLoop('Сколько стоит джип напрокат?', 'Кузьмич', [], [], runs);
    const out = runs.find((r) => r.name === 'search_car_rental')?.output ?? '';
    expect(out).toContain('вернётся во вторник, 27 октября');
    expect(out).toContain('не говори, что проката нет');
    expect(out).not.toMatch(/Suzuki Jimny|Лагуна|7000|car-rental\/laguna-prokat/);
  });

  it('рядом с другим прокатчиком чат называет только его', async () => {
    at(DURING);
    loadCompanies.mockResolvedValue([LAGUNA, BAY]);
    const out = await searchCarRentalForKuzmich({ query: 'джип' });
    expect(out).toContain('Бухта Прокат');
    expect(out).not.toContain('Лагуна');
  });

  it('после срока чат снова называет «Лагуну»', async () => {
    at(AFTER);
    modelAsksRental();
    const runs: ToolRun[] = [];
    await aiChatAgentLoop('Сколько стоит джип напрокат?', 'Кузьмич', [], [], runs);
    expect(runs.find((r) => r.name === 'search_car_rental')?.output).toContain('Suzuki Jimny');
  });
});

describe('MCP и A2A — агенты: прайс «Лагуны» и в паузу', () => {
  it('MCP (поверхность mcp, ею же идёт прямой вызов A2A): прайс и адрес страницы прокатчика', async () => {
    at(DURING);
    const out = await executeKuzmichTool('search_car_rental', { query: 'джип' }, { surface: 'mcp' });
    expect(out).toContain('Лагуна Прокат');
    expect(out).toContain('Suzuki Jimny');
    expect(out).toContain('https://vedarai.ru/car-rental/laguna-prokat');
  });

  it('A2A, свободный вопрос агента: цикл Кузьмича отдаёт модели прайс «Лагуны»', async () => {
    at(DURING);
    modelAsksRental();
    const res = await answerAgentMessage('Rent a self-drive SUV in Kamchatka: price per day', []);
    expect(res.ok).toBe(true);
    const out = rentalToolOutput();
    expect(out).toContain('Suzuki Jimny');
    expect(out).toContain('https://vedarai.ru/car-rental/laguna-prokat');
  });
});
