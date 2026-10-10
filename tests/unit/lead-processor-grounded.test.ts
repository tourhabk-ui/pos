/**
 * AI Lead Processor — тестовая заявка владельца 10.10.
 *
 * Ассистент оформил заказ двух вахтовок на Горелый через create_lead.
 * Обработчик выдал:
 *   - «Группа 52 чел.»: модель перемножила «2 вахтовки по 26 мест»;
 *   - «бюджет 150 000 ₽»: «75 000 ₽ за машину» × 2, дальше Bull назвал это
 *     «(сильный) Назван точный бюджет», а предложение — «ровно ваш бюджет»;
 *   - «Дней 24»: длина чужого тура (CEIL(192 ч / 8)), а не запрос клиента;
 *   - «Благодарю за обращение в TourHab»;
 *   - «Здравствуйте, Нина Васильевна!» — так в заявке звали перевозчика;
 *   - подбор многодневных туров к заказу машины.
 *
 * Сторож держит каждую из шести причин.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const queryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => queryMock(...a) } }));
const aiMock = vi.fn();
vi.mock('@/lib/ai/providers', () => ({ callAIFast: (...a: unknown[]) => aiMock(...a) }));
vi.mock('@/lib/crm/events', () => ({
  recordSourceEventQuietly: vi.fn(async () => undefined),
  statusChangeTitle: () => 't',
}));

import { LeadProcessorService, callStrategyWithoutName } from '@/lib/services/operators/lead-processor.service';
import { groundIntentNumbers, groupAttested, budgetAttested, durationAttested } from '@/lib/leads/intent-grounding';
import { isVehicleOrder, LeadIsVehicleOrderError } from '@/lib/leads/vehicle-order';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

// Текст заявки 10.10 дословно (как его записал create_lead).
const CHARTER_TEXT = '[Интерес: Трансфер на вахтовке на вулкан Горелый] Трансфер на вахтовке на вулкан Горелый, 20 ноября 2026. '
  + 'Заказ целой машины: ИП Миронова Нина Васильевна, 2 вахтовки по 26 мест, Горелый — 75 000 ₽ за машину, '
  + 'отправление из Петропавловска-Камчатского, расчёт наличными. Состав группы и детали маршрута уточнит по телефону.';

const src = (text: string, extra: Partial<Parameters<typeof groundIntentNumbers>[1]> = {}) => ({
  text, formGroupSize: null, formBudgetRub: null, sourceData: null, ...extra,
});

describe('числа намерения — только названные в заявке', () => {
  it('заявка 10.10: 52, 150 000 и 24 не названы — все три null', () => {
    expect(groundIntentNumbers({ group_size: 52, budget_rub: 150000, duration_days: 24 }, src(CHARTER_TEXT)))
      .toEqual({ group_size: null, budget_rub: null, duration_days: null });
  });

  it('цена машины — не бюджет клиента, места в машине — не группа', () => {
    expect(budgetAttested(CHARTER_TEXT, 75000)).toBe(false);
    expect(groupAttested(CHARTER_TEXT, 26)).toBe(false);
  });

  it('названное число людей остаётся — цифрой и словом', () => {
    expect(groundIntentNumbers({ group_size: 4 }, src('Нас 4 человека, хотим на вулкан')).group_size).toBe(4);
    expect(groundIntentNumbers({ group_size: 4 }, src('нас четверо, июль')).group_size).toBe(4);
    expect(groundIntentNumbers({ group_size: 3 }, src('семья из трёх человек')).group_size).toBe(3);
    expect(groundIntentNumbers({ group_size: 6 }, src('группа из 6, рыбалка')).group_size).toBe(6);
  });

  it('названный бюджет остаётся: «100к», «до 150 тыс.», «1,5 млн»', () => {
    expect(groundIntentNumbers({ budget_rub: 100000 }, src('бюджет 100к на двоих')).budget_rub).toBe(100000);
    expect(groundIntentNumbers({ budget_rub: 150000 }, src('готовы потратить до 150 тыс. на всех')).budget_rub).toBe(150000);
    expect(groundIntentNumbers({ budget_rub: 1500000 }, src('Бюджет 1,5 млн')).budget_rub).toBe(1500000);
    expect(groundIntentNumbers({ budget_rub: 120000 }, src('бюджет 120 000 руб')).budget_rub).toBe(120000);
  });

  it('срок: дни, недели, ночи; «на неделю» без числа', () => {
    expect(durationAttested('хотим на 5 дней', 5)).toBe(true);
    expect(durationAttested('две недели в августе', 14)).toBe(true);
    expect(durationAttested('на неделю', 7)).toBe(true);
    expect(durationAttested('на 5 ночей', 6)).toBe(true);
    expect(durationAttested('20 ноября 2026', 20)).toBe(false);
  });

  it('поле формы главнее модели; план из данных заявки подтверждает группу', () => {
    expect(groundIntentNumbers({ group_size: 52, budget_rub: 1 }, src('', { formGroupSize: 3, formBudgetRub: 90000 })))
      .toMatchObject({ group_size: 3, budget_rub: 90000 });
    expect(groundIntentNumbers({ group_size: 3 }, src('план поездки', { sourceData: { plan: { adults: 2, children: 1 } } })).group_size)
      .toBe(3);
  });

  it('мусор вместо числа — null', () => {
    expect(groundIntentNumbers({ group_size: 'много', budget_rub: -5, duration_days: 0 }, src('нас 5 человек')))
      .toEqual({ group_size: null, budget_rub: null, duration_days: null });
  });
});

describe('заявка на машину — не подбор тура', () => {
  it('заявка 10.10 — заказ машины', () => {
    expect(isVehicleOrder(CHARTER_TEXT)).toBe(true);
    expect(isVehicleOrder('Нужна вахтовка на Мутновку для 20 туристов')).toBe(true);
    expect(isVehicleOrder('Аренда микроавтобуса на 3 дня')).toBe(true);
  });

  it('тур с вахтовкой, трансфер к туру и обычная заявка — подбор тура', () => {
    expect(isVehicleOrder('Тур на Горелый на вахтовке, нас 6')).toBe(false);
    // Машина названа предметом заказа, но тур упомянут — это подбор тура.
    expect(isVehicleOrder('Нужна вахтовка для тура на Мутновку')).toBe(false);
    expect(isVehicleOrder('Тур на Горелый, заказ вахтовки на всю группу')).toBe(false);
    expect(isVehicleOrder('Хотим на вулкан, нужен трансфер из аэропорта')).toBe(false);
    expect(isVehicleOrder('Хотим на вулкан')).toBe(false);
    expect(isVehicleOrder(null)).toBe(false);
  });
});

describe('стратегия звонка без обращения по имени', () => {
  it('имя из приветствия снимается, остальное остаётся', () => {
    expect(callStrategyWithoutName('Здравствуйте, Нина Васильевна! По вашему запросу на 20 ноября: уточню погоду.'))
      .toBe('Здравствуйте! По вашему запросу на 20 ноября: уточню погоду.');
    expect(callStrategyWithoutName('Добрый день, Анна. Начните с дат.')).toBe('Добрый день. Начните с дат.');
    expect(callStrategyWithoutName('Начните с вопроса о датах.')).toBe('Начните с вопроса о датах.');
  });
});

// ── Конвейер целиком ────────────────────────────────────────────────────────

const BASE_LEAD = {
  id: 'lead-1', operator_id: null, name: 'тест', phone: '+79098880000', email: null,
  comment: 'Хотим на вулкан Горелый в августе', route_title: null, source_data: null,
  group_size: null, budget_rub: null, desired_dates: null, status: 'new',
};

const TOURS = [
  // 192 часа без multi_day_count: по CEIL(ч/8) было 24 дня, по правилу каталога — 8.
  { id: '11', title: 'Сплав по реке Быстрая, вулканы Горелый и Авачинский', price: 115000,
    duration_type: null, multi_day_count: null, duration_hours: '192.00', activity_type: 'volcano', description: '' },
  { id: '12', title: 'Курильское озеро и вулканы', price: 140000,
    duration_type: 'multi_day', multi_day_count: 5, duration_hours: '192.00', activity_type: 'volcano', description: '' },
];

function routeQueries(lead: typeof BASE_LEAD) {
  queryMock.mockImplementation(async (sql: string) => {
    if (/FROM leads WHERE id = \$1/.test(sql)) return { rows: [lead] };
    if (/FROM operator_tours/.test(sql)) return { rows: TOURS };
    if (/INSERT INTO lead_proposals/.test(sql)) return { rows: [{ id: 'prop-1' }] };
    return { rows: [] };
  });
}

const prompts: string[] = [];

function aiAnswers() {
  aiMock.mockImplementation(async (msgs: Array<{ content: string }>) => {
    const text = msgs.map((m) => m.content).join('\n');
    prompts.push(text);
    if (text.includes('Ты — Arbiter')) {
      return JSON.stringify({ conversion_prob: 55, recommended_action: 'send_proposal',
        call_strategy: 'Здравствуйте, Нина Васильевна! Уточните даты.', urgency: 'warm' });
    }
    if (text.includes('Bull-агент')) return '{"signals":[]}';
    if (text.includes('Bear-агент')) return '{"risks":[]}';
    if (text.includes('AI-квалификатор')) {
      return JSON.stringify({ activity_types: ['volcano'], group_size: 52, budget_rub: 150000, desired_dates: null,
        duration_days: 24, interests: ['вулканы'], urgency: 'medium', qualification_notes: 'n' });
    }
    return '{"headline":"h","summary":"Здравствуйте, {name}!","highlights":[]}';
  });
}

beforeEach(() => {
  queryMock.mockReset();
  aiMock.mockReset();
  prompts.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('LeadProcessorService.process', () => {
  it('выдуманные группа, бюджет и срок не доходят ни до анализа, ни до результата', async () => {
    routeQueries(BASE_LEAD);
    aiAnswers();
    const res = await new LeadProcessorService().process('lead-1');
    expect(res.intent.group_size).toBeNull();
    expect(res.intent.budget_rub).toBeNull();
    expect(res.intent.duration_days).toBeNull();
    const bull = prompts.find((p) => p.includes('Bull-агент')) ?? '';
    expect(bull).toContain('Группа: не названа');
    expect(bull).toContain('Бюджет клиента: не назван');
    expect(bull).not.toMatch(/52 чел|150[\s ]000/);
  });

  it('срок предложения — запрос клиента, а не длина тура; дни тура — по правилу каталога', async () => {
    routeQueries(BASE_LEAD);
    aiAnswers();
    const res = await new LeadProcessorService().process('lead-1');
    expect(res.duration_days).toBeNull();
    const days = [res.primary_tour, ...res.alt_tours].map((t) => t?.duration_days).sort();
    expect(days).toEqual([5, 8]);
    const insert = queryMock.mock.calls.find((c) => /INSERT INTO lead_proposals/.test(String(c[0])));
    expect((insert?.[1] as unknown[])[8]).toBeNull(); // duration_days
  });

  it('предложение от Ведара, стратегия звонка без чужого имени', async () => {
    routeQueries(BASE_LEAD);
    aiAnswers();
    const res = await new LeadProcessorService().process('lead-1');
    const proposalPrompt = prompts.find((p) => p.includes('коммерческое предложение')) ?? '';
    expect(proposalPrompt).toContain('платформы Ведар');
    expect(proposalPrompt).not.toMatch(/TourHab/i);
    expect(res.adversarial?.callStrategy).toBe('Здравствуйте! Уточните даты.');
    expect(res.summary).toBe('Здравствуйте, тест!');
  });

  it('заявка на машину: без ИИ и подбора, закрыта для крона, статус не тронут', async () => {
    routeQueries({ ...BASE_LEAD, comment: CHARTER_TEXT });
    aiAnswers();
    await expect(new LeadProcessorService().process('lead-1')).rejects.toBeInstanceOf(LeadIsVehicleOrderError);
    expect(aiMock).not.toHaveBeenCalled();
    const sql = queryMock.mock.calls.map((c) => String(c[0]));
    expect(sql.some((s) => /status = 'ai_processing'/.test(s))).toBe(false);
    expect(sql.some((s) => /FROM operator_tours/.test(s))).toBe(false);
    expect(sql.some((s) => /SET processed_at = COALESCE\(processed_at, NOW\(\)\)/.test(s))).toBe(true);
  });
});

describe('исходники', () => {
  const svc = read('lib/services/operators/lead-processor.service.ts');

  it('длительность тура нигде не считается делением часов на 8', () => {
    expect(svc).not.toMatch(/\/\s*8\.0/);
    expect(svc).toMatch(/tourDays\(/);
  });

  it('квалификатор не ставит группу 1 «по умолчанию» и не просит её', () => {
    expect(svc).not.toMatch(/group_size:\s*lead\.group_size\s*\?\?\s*1/);
    expect(svc).not.toMatch(/1 если неизвестно/);
    expect(svc).toMatch(/groundIntentNumbers\(/);
  });

  it('MCP create_lead: заказ машины уходит менеджеру без AI-подбора, описание ведёт в request_charter', () => {
    const route = read('app/api/mcp/route.ts');
    const fn = route.slice(route.indexOf('async function executeCreateLead'), route.indexOf('function refuseSilentLead'));
    expect(fn).toMatch(/skip_ai_processing:\s*isVehicleOrder\(leadComment\)/);
    const tools = read('lib/mcp/public-tools.ts');
    const createLead = tools.slice(tools.indexOf('export const CREATE_LEAD_TOOL'), tools.indexOf('export const BOOKING_REQUEST_TOOL'));
    expect(createLead).toMatch(/request_charter/);
  });

  it('экран лида: «Бюджет» — бюджет клиента, не цена тура; не названное подписано', () => {
    const ui = read('app/hub/operator/leads/[id]/_LeadDetailClient.tsx');
    expect(ui).not.toMatch(/proposal\.price_from[\s\S]{0,400}>Бюджет</);
    expect(ui).toMatch(/label="Бюджет клиента"[\s\S]{0,200}proposal\.intent\.budget_rub/);
    expect(ui).toMatch(/label="Срок"[\s\S]{0,200}proposal\.intent\.duration_days/);
    expect(ui).toMatch(/missing="не названа"/);
  });
});
