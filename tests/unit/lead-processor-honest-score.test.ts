/**
 * AI Lead Processor: честная оценка и подбор только своих туров.
 *
 * 1) При недоступном ИИ Arbiter подставлял conversion_prob 50, и лид получал
 *    ai_score около 50 «из воздуха». Теперь оценки нет — NULL, лид остаётся
 *    «новым», предложение с выдуманным числом не сохраняется.
 * 2) Подбор туров для лида оператора шёл по всему каталогу — в предложение
 *    от имени оператора попадали туры конкурентов. При нуле совпадений
 *    подставлялись случайные туры (ORDER BY RANDOM) «по популярности».
 * 3) getProposal отдавал alt_tours: [] и не отдавал разбор; экран умножал
 *    conversion_prob (уже проценты) на 100.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const queryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => queryMock(...a) } }));
const aiMock = vi.fn();
vi.mock('@/lib/ai/providers', () => ({ callAIFast: (...a: unknown[]) => aiMock(...a) }));

import {
  LeadProcessorService,
  LeadNotScoredError,
  verdictFromRow,
} from '@/lib/services/operators/lead-processor.service';

const LEAD = {
  id: 'lead-1',
  operator_id: 'op-A',
  name: 'Анна',
  phone: '+7',
  email: null,
  comment: 'Хотим на вулкан',
  route_title: null,
  source_data: null,
  group_size: 2,
  budget_rub: null,
  desired_dates: null,
  status: 'new',
};

function routeQueries(tours: unknown[] = []) {
  queryMock.mockImplementation(async (sql: string) => {
    if (/FROM leads WHERE id = \$1/.test(sql)) return { rows: [LEAD] };
    if (/FROM operator_tours/.test(sql)) return { rows: tours };
    if (/INSERT INTO lead_proposals/.test(sql)) return { rows: [{ id: 'prop-1' }] };
    return { rows: [] };
  });
}

function sqls(): string[] {
  return queryMock.mock.calls.map((c) => String(c[0]));
}

function aiAnswers(arbiter: string, activity: string[] = []) {
  aiMock.mockImplementation(async (msgs: Array<{ content: string }>) => {
    const text = msgs.map((m) => m.content).join('\n');
    if (text.includes('Ты — Arbiter')) return arbiter;
    if (text.includes('Bull-агент')) return '{"signals":[]}';
    if (text.includes('Bear-агент')) return '{"risks":[]}';
    if (text.includes('AI-квалификатор')) {
      return JSON.stringify({ activity_types: activity, group_size: 2, budget_rub: null, desired_dates: null,
        duration_days: null, interests: [], urgency: 'medium', qualification_notes: 'n' });
    }
    return '{"headline":"h","summary":"s","highlights":[]}';
  });
}

beforeEach(() => {
  queryMock.mockReset();
  aiMock.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('ИИ недоступен — «не оценено», а не 50', () => {
  it('process бросает LeadNotScoredError, ai_score не пишется, лид возвращается в new', async () => {
    routeQueries();
    aiMock.mockResolvedValue('Сервис временно недоступен.');
    const svc = new LeadProcessorService();
    await expect(svc.process('lead-1')).rejects.toBeInstanceOf(LeadNotScoredError);

    const all = sqls();
    expect(all.some((s) => /INSERT INTO lead_proposals/.test(s))).toBe(false);
    expect(all.some((s) => /ai_score\s*=\s*\$1/.test(s))).toBe(false);
    expect(all.some((s) => /SET status = 'new'/.test(s))).toBe(true);
  });

  it('Arbiter ответил — оценка считается и пишется', async () => {
    routeQueries();
    aiAnswers('{"conversion_prob":80,"recommended_action":"call_immediately","call_strategy":"x","urgency":"hot"}');
    const svc = new LeadProcessorService();
    const res = await svc.process('lead-1');
    expect(typeof res.ai_score).toBe('number');
    expect(res.adversarial?.conversionProb).toBe(80);
  });
});

describe('подбор туров', () => {
  it('лид оператора — только туры этого оператора, без RANDOM', async () => {
    routeQueries();
    aiAnswers('{"conversion_prob":40}', ['volcano']);
    await new LeadProcessorService().process('lead-1');
    const tourCalls = queryMock.mock.calls.filter((c) => /FROM operator_tours/.test(String(c[0])));
    expect(tourCalls.length).toBe(1); // нет «запасного» запроса любых туров
    const [sql, params] = tourCalls[0];
    expect(String(sql)).toMatch(/operator_id = \$\d+::uuid/);
    expect(params).toContain('op-A');
    expect(String(sql)).not.toMatch(/RANDOM\(\)/i);
  });

  it('в коде нет подписи «рекомендован по популярности»', () => {
    const src = readFileSync(join(process.cwd(), 'lib/services/operators/lead-processor.service.ts'), 'utf8');
    expect(src).not.toMatch(/push\('рекомендован по популярности'\)/);
  });
});

describe('getProposal', () => {
  it('отдаёт разбор, альтернативы и NULL-оценку как null', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/FROM lead_proposals lp/.test(sql)) {
        return {
          rows: [{
            id: 'prop-1', lead_id: 'lead-1', headline: 'h', summary: 's', highlights: [],
            price_from: null, price_to: null, duration_days: null, generation_ms: 10,
            primary_tour_id: null, tour_title: null, alt_tour_ids: ['7', '9'],
            ai_score: null, ai_intent: {},
            bull_signals: ['(сильный) бюджет'], bear_risks: [], conversion_prob: 62,
            recommended_action: 'send_proposal', call_strategy: 'c', verdict_urgency: 'warm',
          }],
        };
      }
      if (/FROM operator_tours/.test(sql)) {
        return { rows: [{ id: '9', title: 'B', price: 2, duration_days: 1, activity_type: 'x', description: '' },
                        { id: '7', title: 'A', price: 1, duration_days: 1, activity_type: 'x', description: '' }] };
      }
      return { rows: [] };
    });
    const p = await new LeadProcessorService().getProposal('prop-1');
    expect(p?.ai_score).toBeNull();
    expect(p?.alt_tours.map((t) => t.id)).toEqual(['7', '9']);
    expect(p?.adversarial?.conversionProb).toBe(62);
    expect(p?.adversarial?.bullSignals).toEqual(['(сильный) бюджет']);
  });

  it('verdictFromRow: пустая строка разбора — undefined, не пустой блок', () => {
    expect(verdictFromRow({ bull_signals: [], bear_risks: [], conversion_prob: null })).toBeUndefined();
  });
});

describe('экран лида', () => {
  const ui = readFileSync(join(process.cwd(), 'app/hub/operator/leads/[id]/_LeadDetailClient.tsx'), 'utf8');
  it('conversion_prob не умножается на 100', () => {
    expect(ui).not.toMatch(/conversionProb \* 100/);
  });
  it('NULL-оценка показывается как «не оценено»', () => {
    expect(ui).toMatch(/не оценено/);
    expect(ui).toMatch(/score: number \| null/);
  });
});
