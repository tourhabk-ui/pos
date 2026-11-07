/**
 * Данные заявки в промпте квалификатора — без идентификаторов человека.
 *
 * Ревью безопасности PR #3104: обработчик заявок отдавал зарубежной модели
 * `redactPII(JSON.stringify(source_data))`. redactPII режет телефоны и почту,
 * а `telegram_user_id`, `telegram_username` (заявка из Telegram) и
 * `max_chat_id` (из MAX) проходили. Вызовом: правило — на данных, конвейер —
 * по тексту, который ушёл модели.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => queryMock(...a) } }));
const aiMock = vi.fn();
vi.mock('@/lib/ai/providers', () => ({ callAIFast: (...a: unknown[]) => aiMock(...a) }));
vi.mock('@/lib/crm/events', () => ({
  recordSourceEventQuietly: vi.fn(async () => undefined),
  statusChangeTitle: () => 't',
}));

import { sourceDataForModel } from '@/lib/leads/source-for-model';
import { LeadProcessorService } from '@/lib/services/operators/lead-processor.service';

/** Идентификаторы канала — выдуманные, но той же формы, что пишут боты. */
const TG = { source: 'telegram_lead_flow', telegram_user_id: 731904455, telegram_username: 'anna_kamchatka', chat_id: 731904455 };
const MAX = { source: 'max_bot', max_chat_id: 'max-5512903', timestamp: '2026-11-07T05:00:00Z' };

describe('sourceDataForModel — только поля о поездке', () => {
  it('идентификаторы Telegram и MAX не проходят', () => {
    expect(sourceDataForModel(TG)).toEqual({ source: 'telegram_lead_flow' });
    expect(sourceDataForModel(MAX)).toEqual({ source: 'max_bot' });
  });

  it('интересы, даты и состав проходят; вложенное и незнакомое — нет; телефон в поле режется', () => {
    const out = sourceDataForModel({
      source: 'telegram_bot', interests: ['вулканы', 'рыбалка'], date_from: '2027-07-10', date_to: '2027-07-15',
      participants: 2, contact: { name: 'Анна', phone: '+79140000000' }, customer_name: 'Анна Петрова',
      comment_extra: 'звоните +7 914 000-00-00', budget: 'около 200 тысяч, мой тел +7 914 000-00-00',
    });
    expect(out).toEqual({
      source: 'telegram_bot', interests: ['вулканы', 'рыбалка'], date_from: '2027-07-10', date_to: '2027-07-15',
      participants: 2, budget: expect.not.stringContaining('914') as unknown as string,
    });
    expect(JSON.stringify(out)).not.toMatch(/Анна|914|contact|customer_name/);
  });

  it('пусто — пусто', () => {
    expect(sourceDataForModel(null)).toEqual({});
    expect(sourceDataForModel(undefined)).toEqual({});
  });
});

const TOURS = [
  { id: '12', title: 'Курильское озеро и вулканы', price: 140000,
    duration_type: 'multi_day', multi_day_count: 5, duration_hours: '120.00', activity_type: 'volcano', description: '' },
];

const prompts: string[] = [];

function run(sourceData: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const lead = {
    id: 'lead-1', operator_id: null, name: 'Анна', phone: '@anna_kamchatka', email: null,
    comment: 'Хотим на вулкан в июле', route_title: null, source_data: sourceData,
    group_size: null, budget_rub: null, desired_dates: null, status: 'new', ...extra,
  };
  queryMock.mockImplementation(async (sql: string) => {
    if (/FROM leads WHERE id = \$1/.test(sql)) return { rows: [lead] };
    if (/FROM operator_tours/.test(sql)) return { rows: TOURS };
    if (/INSERT INTO lead_proposals/.test(sql)) return { rows: [{ id: 'prop-1' }] };
    return { rows: [] };
  });
  aiMock.mockImplementation(async (msgs: Array<{ content: string }>) => {
    const text = msgs.map((m) => m.content).join('\n');
    prompts.push(text);
    if (text.includes('Ты — Arbiter')) {
      return JSON.stringify({ conversion_prob: 55, recommended_action: 'send_proposal', call_strategy: 'Уточните даты.', urgency: 'warm' });
    }
    if (text.includes('Bull-агент')) return '{"signals":[]}';
    if (text.includes('Bear-агент')) return '{"risks":[]}';
    if (text.includes('AI-квалификатор')) {
      return JSON.stringify({ activity_types: ['volcano'], group_size: null, budget_rub: null, desired_dates: null,
        duration_days: null, interests: ['вулканы'], urgency: 'medium', qualification_notes: 'n' });
    }
    return '{"headline":"h","summary":"Здравствуйте, {name}!","highlights":[]}';
  });
  return new LeadProcessorService().process('lead-1');
}

beforeEach(() => {
  queryMock.mockReset();
  aiMock.mockReset();
  prompts.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('конвейер заявки: модели не уходят идентификаторы канала', () => {
  it('заявка из Telegram: ни id, ни username в промптах', async () => {
    await run(TG);
    const qualify = prompts.find((p) => p.includes('AI-квалификатор')) ?? '';
    expect(qualify).toContain('telegram_lead_flow');
    for (const p of prompts) expect(p).not.toMatch(/731904455|anna_kamchatka/);
  });

  // Ревью безопасности PR #3127: соседние свободные поля формы шли в тот же
  // промпт без чистки — публичный POST /api/leads пишет их как есть.
  it('свободные поля формы (маршрут, даты): телефон и почта до модели не доходят', async () => {
    await run({ source: 'website' }, {
      route_title: 'Тур на Авачинский, +7 914 123-45-67',
      desired_dates: '10–17 июля, пишите anna.k@example.ru',
    });
    const qualify = prompts.find((p) => p.includes('AI-квалификатор')) ?? '';
    expect(qualify).toContain('Тур на Авачинский');
    expect(qualify).toContain('10–17 июля');
    for (const p of prompts) expect(p).not.toMatch(/123-45-67|anna\.k@example\.ru/);
  });

  it('заявка из MAX: идентификатора чата в промптах нет', async () => {
    await run(MAX);
    expect(prompts.length).toBeGreaterThan(0);
    for (const p of prompts) expect(p).not.toContain('max-5512903');
  });
});
