/**
 * Инструкция хосту в ответ на initialize (ловушки MCP 29.10, часть 4) —
 * сторож связки «правило инструкции → код, который его исполняет».
 *
 * Инструкция — объявление: хост может положить её в контекст модели, и модель верит
 * ей больше, чем ответу инструмента, который ещё не видела. Объявление без
 * производителя (CLAUDE.md §4, правило 10.09) здесь опаснее обычного: фраза
 * «листай, пока ответ не скажет «Это последняя»» при ответе, который говорит
 * иначе, — бесконечный цикл или обрыв на середине каталога.
 *
 * Поэтому каждая цитата в «ёлочках» — фраза, которую печатает настоящий код:
 * сторож зовёт производителя на граничных данных (пул базы подменён) и ищет
 * фразу в его выводе И в инструкции. Множество цитат равно множеству ключей
 * таблицы плюс явные не-цитаты с причиной: новая цитата без производителя —
 * красный. Правила без цитат держатся вызовами (МЧС, ключ статуса, consent,
 * оплата), запреты — регуляркой по ВЫХОДУ (решение 13.10).
 */
import { describe, it, expect, vi } from 'vitest';

const query = vi.fn();
const fetchAvailabilityForTour = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
vi.mock('@/lib/planner', () => ({
  createPlannerCache: () => ({}),
  fetchAvailabilityForTour: (...a: unknown[]) => fetchAvailabilityForTour(...a),
}));

import { SERVER_INSTRUCTIONS, buildServerInstructions, paymentRule } from '@/lib/mcp/server-instructions';
import {
  PUBLIC_MCP_TOOLS, PUBLIC_MCP_TOOL_NAMES, WRITE_TOOL_NAMES,
  BOOKING_REQUEST_TOOL, REQUEST_CHARTER_TOOL, CAR_RENTAL_REQUEST_TOOL, STAY_REQUEST_TOOL,
} from '@/lib/mcp/public-tools';
import { paginateTourText, TOURS_PAGE_SIZE, NO_SELLER_NAMES } from '@/lib/kuzmich/tour-filter';
import { executeKuzmichTool } from '@/lib/kuzmich/core';
import { getTourAvailabilityForKuzmich } from '@/lib/kuzmich/tour-availability-tool';
import { getGuardianContext, routeFactsLines } from '@/lib/kuzmich/guardian-context';
import { routeFacts } from '@/lib/ai/route-knowledge';
import { placeFactLines } from '@/lib/kuzmich/place-info-tool';
import { keyLine } from '@/lib/mcp/request-status';
import { seatRequestPaymentNote } from '@/lib/seat-requests/core';
import { platformAcceptsPayments } from '@/lib/payments/accepting';

// ── Граничные данные и вызовы производителей ────────────────────────────────

const tourLines = (n: number) => Array.from({ length: n }, (_, i) => `ID${i + 1}: "Тур ${i + 1}" тип:volcano`);
const catalog = (n: number) => ['РЕАЛЬНЫЕ ТУРЫ НА ПЛАТФОРМЕ:', ...tourLines(n), '', 'Хвост каталога.'].join('\n');

/** Строка базы, как её отдаёт SELECT каталога get_tours (lib/kuzmich/core). */
const tourRow = (id: number, over: Record<string, unknown>) => ({
  id, title: `Тур ${id}`, base_price: 10000, price_unit: 'per_person', multi_day_count: null,
  activity_type: 'trekking', location_name: null, duration_type: null, duration_hours: null,
  season_start: null, season_end: null, available_slots: 0, next_available_date: null,
  short_description: null, has_schedule: false, has_details: false, operator_name: 'Тестовая компания',
  description: null, program_text: null, main_place_name: null, main_place_type: null,
  ...over,
});

/** Тур 1 — с календарём и местами, тур 2 — без календаря (оператор берёт без него). */
const CATALOG_ROWS = [
  tourRow(1, { title: 'Восхождение', has_schedule: true, available_slots: 4, next_available_date: '2027-07-19' }),
  tourRow(2, { title: 'Сплав', activity_type: 'rafting', has_schedule: false }),
];

/**
 * get_tours настоящим исполнителем, как его зовёт MCP. Каталог кэшируется
 * модулем на сутки — строки базы одни на весь файл, поэтому кэш не мешает.
 */
async function getToursMcp(args: Record<string, string> = {}): Promise<string> {
  query.mockReset().mockResolvedValue({ rows: CATALOG_ROWS });
  return executeKuzmichTool('get_tours', args, { surface: 'mcp' });
}
const lineOf = (text: string, id: number) => text.split('\n').find((l) => l.startsWith(`ID${id}:`)) ?? '';

/** Место с зелёным пересчётом десять минут назад, камчатский район; over — правка строки. */
async function guardianGreen(over: Record<string, unknown> = {}): Promise<string> {
  const place = {
    name: 'Озеро Тихое', description: null, location_type: 'lake', lat: 53.1, lng: 158.4, zone: 'northern',
    hazard_types: null, difficulty_level: null, altitude_m: null, nearest_medical_km: null,
    sat_communicator_required: null, capacity_per_day: null, open_from_date: null, open_to_date: null,
    is_open: true, current_crowds: null, active_alerts: null, recommender_status: 'green',
    alert_message: null, alert_severity: null, tourists_today: null,
    volcano_acc: null, volcano_ash_height_m: null, volcano_observed_at: null,
    status_updated_at: new Date(Date.now() - 600_000).toISOString(),
    ...over,
  };
  query.mockReset().mockImplementation((sql: string) =>
    Promise.resolve({ rows: sql.includes('FROM places') ? [place] : [] }));
  return (await getGuardianContext('Озеро Тихое')) ?? '';
}

/** Заголовок места в ответе guardian: имя, тип и цвет статуса в скобках. */
const headerOf = (out: string) => out.split('\n').find((l) => l.startsWith('Озеро Тихое')) ?? '';

/** Пустое окно get_tour_availability: окно пусто, после окна — свободная дата. */
async function availabilityEmptyWindow(): Promise<{ out: string; next: string }> {
  const tour = { id: 27, title: 'Сплав по реке Быстрая', base_price: 13000, price_unit: 'person' };
  query.mockReset().mockImplementation(async (sql: string) => (/ta_sched/.test(sql) ? { rows: [{ has: true }] } : { rows: [tour] }));
  const next = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
  fetchAvailabilityForTour.mockReset()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ date: next, remaining: 3, priceOverride: null }]);
  return { out: await getTourAvailabilityForKuzmich({ tour: '27' }), next };
}

const route = (over: Record<string, unknown>) => ({ id: 'r1', title: 'Маршрут к озеру', ...over });

// ── 1. Цитата в инструкции → производитель ──────────────────────────────────

interface Producer { who: string; produce: () => string | Promise<string> }

/**
 * Цитата → кто её печатает. «…» в цитате — место для данных: части по обе
 * стороны ищутся в выводе по порядку («Мест: …» — «Мест: 4»).
 */
const PRODUCERS: Record<string, Producer> = {
  'Это последняя': {
    who: 'paginateTourText, последняя из двух страниц',
    produce: () => paginateTourText(catalog(TOURS_PAGE_SIZE + 1), 2),
  },
  'Других страниц нет': {
    who: 'paginateTourText, единственная страница',
    produce: () => paginateTourText(catalog(1), 1),
  },
  'Мест: …': {
    who: 'get_tours на MCP, строка тура с календарём',
    produce: async () => lineOf(await getToursMcp(), 1),
  },
  'Расписания в системе нет': {
    who: 'get_tours на MCP, строка тура без календаря',
    produce: async () => lineOf(await getToursMcp(), 2),
  },
  'свободных мест с … по … нет': {
    who: 'get_tour_availability, пустое окно',
    produce: async () => (await availabilityEmptyWindow()).out,
  },
  'ЗЕЛЁНЫЙ': {
    // Только заголовок места — «в скобках у названия»: тот же цвет печатает
    // и строка KVERT, и правило 5 о ней не говорит (ревью 29.10).
    who: 'get_guardian_context, заголовок места с зелёным пересчётом',
    produce: async () => headerOf(await guardianGreen()).match(/\[([^\]]*)\]/)?.[1] ?? '',
  },
};

/**
 * «Ёлочки», которые не цитируют вывод инструмента. Пересказ здесь — долг,
 * а не норма: у каждого названо, какая проверка ниже держит его смысл.
 */
const NOT_QUOTES: Record<string, string> = {
  'безопасно': 'слово, которым ЗЕЛЁНЫЙ НЕ является: правило его отрицает; смысл — «правило 5: ЗЕЛЁНЫЙ»',
  'не нужна': 'вывод, которого нельзя делать из незаписанной регистрации; строку маршрута держит «правило 5: МЧС»',
};

/** Все «ёлочки» инструкции при обоих положениях выключателя оплаты. */
function quotesOf(...texts: string[]): Set<string> {
  return new Set(texts.flatMap((t) => [...t.matchAll(/«([^»]*)»/g)].map((m) => m[1])));
}

function containsInOrder(text: string, quote: string): boolean {
  let from = 0;
  for (const part of quote.split('…').map((p) => p.trim()).filter(Boolean)) {
    const at = text.indexOf(part, from);
    if (at < 0) return false;
    from = at + part.length;
  }
  return true;
}

describe('инструкция: каждая цитата печатается настоящим кодом', () => {
  it('множество цитат = производители + названные не-цитаты; новая цитата без производителя — красный', () => {
    const quotes = quotesOf(buildServerInstructions({ acceptsPayments: false }), buildServerInstructions({ acceptsPayments: true }));
    const declared = [...Object.keys(PRODUCERS), ...Object.keys(NOT_QUOTES)];
    expect(new Set(declared).size, 'цитата и в производителях, и в не-цитатах').toBe(declared.length);
    expect([...quotes].sort()).toEqual([...declared].sort());
    for (const [q, why] of Object.entries(NOT_QUOTES)) expect(why.length, q).toBeGreaterThan(20);
  });

  it.each(Object.entries(PRODUCERS))('«%s» — в выводе производителя и в инструкции', async (quote, p) => {
    const out = await p.produce();
    expect(containsInOrder(out, quote), `${p.who} не печатает «${quote}»:\n${out}`).toBe(true);
    expect(SERVER_INSTRUCTIONS).toContain(`«${quote}»`);
  });
});

// ── 2. Правила без цитат: вызовы на граничных данных ───────────────────────

describe('правило 2: страницы get_tours и имена продавцов', () => {
  it('фразы остановки — только на последней странице: на первой из двух их нет', () => {
    // Иначе модель по правилу 2 остановится на первой странице — ложная
    // находка #2362 (7 туров из 22). Подстрока на последней странице этого не ловит.
    const p1 = paginateTourText(catalog(TOURS_PAGE_SIZE + 1), 1);
    for (const stop of ['Это последняя', 'Других страниц нет']) expect(p1, stop).not.toContain(stop);
    expect(p1).toMatch(/Следующая — get_tours с page=2/);
  });

  it('число туров на странице в тексте — TOURS_PAGE_SIZE, и первая страница несёт ровно столько', () => {
    const said = Number(SERVER_INSTRUCTIONS.match(/get_tours отдаёт по (\d+) туров/)?.[1]);
    expect(said).toBe(TOURS_PAGE_SIZE);
    const p1 = paginateTourText(catalog(TOURS_PAGE_SIZE + 3), 1);
    expect(p1.match(/^ID\d+:/gm)).toHaveLength(TOURS_PAGE_SIZE);
  });

  it('имена продавцов get_tours не ищет — ответ «ничего не нашлось» отсылает к get_tour_details, у него есть name', async () => {
    expect(NO_SELLER_NAMES).toContain('get_tour_details');
    const none = await getToursMcp({ activity_type: 'дайвинг' });
    expect(none).toMatch(/^Туров «дайвинг» у операторов платформы сейчас нет/);
    expect(none).toContain(NO_SELLER_NAMES);
    const details = PUBLIC_MCP_TOOLS.find((t) => t.name === 'get_tour_details');
    expect(Object.keys((details?.inputSchema as { properties: object }).properties)).toContain('name');
  });
});

describe('правило 3: «Мест» — только у тура с календарём', () => {
  it('строка тура без календаря не говорит «Мест:», с календарём — не говорит «Расписания в системе нет»', async () => {
    const out = await getToursMcp();
    expect(lineOf(out, 1)).toContain('Мест: 4');
    expect(lineOf(out, 1)).not.toContain('Расписания в системе нет');
    expect(lineOf(out, 2)).not.toContain('Мест:');
  });
});

describe('правило 4: пустое окно get_tour_availability', () => {
  it('«нет» — про окно date_from + days, а ближайшую свободную дату после окна ответ называет сам', async () => {
    const { out, next } = await availabilityEmptyWindow();
    expect(out).toMatch(/свободных мест с \S+ по \S+ нет/);
    expect(out).toContain('Ближайшая свободная дата после этого окна');
    expect(out).toContain(`date_from=${next}`);
    const props = Object.keys((PUBLIC_MCP_TOOLS.find((t) => t.name === 'get_tour_availability')?.inputSchema as { properties: object }).properties);
    expect(props).toEqual(expect.arrayContaining(['date_from', 'days']));
  });
});

describe('правило 5: ЗЕЛЁНЫЙ', () => {
  it('инструкция привязывает ЗЕЛЁНЫЙ к скобкам у названия места, а не к шкалам вулкана', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/«ЗЕЛЁНЫЙ» в скобках у названия места — статус места для выхода, а не «безопасно»/);
    expect(SERVER_INSTRUCTIONS).toMatch(/KVERT и КФ ЕГС — шкалы вулкана, не места/);
    expect(SERVER_INSTRUCTIONS).toMatch(/предупреждения и опасности из ответа передай/);
  });

  it('зелёный без предупреждений — «не найдено» и «не гарантия безопасности»', async () => {
    const out = await guardianGreen();
    expect(headerOf(out)).toContain('[ЗЕЛЁНЫЙ]');
    expect(out).toContain('ЗЕЛЁНЫЙ значит: активных предупреждений по месту не найдено');
    expect(out).toContain('Это не гарантия безопасности.');
  });

  it('зелёный при предупреждениях низкого уровня — не «не найдено», а «не подняли», и сами предупреждения в ответе', async () => {
    // safety-ingest оставляет место зелёным при предупреждениях уровня ≤1;
    // до 29.10 ответ говорил «не найдено» прямо над «Активные алерты: …».
    const out = await guardianGreen({ active_alerts: ['Перевал — проезд по пропускам'] });
    expect(headerOf(out)).toContain('[ЗЕЛЁНЫЙ]');
    expect(out).not.toContain('не найдено');
    expect(out).toContain('ЗЕЛЁНЫЙ значит: предупреждения ниже статус места для выхода не подняли');
    expect(out).toContain('Активные алерты: Перевал — проезд по пропускам.');
    expect(out).toContain('Это не гарантия безопасности.');
    const withMessage = await guardianGreen({ alert_message: 'Туман на перевале' });
    expect(withMessage).not.toContain('не найдено');
    expect(withMessage).toContain('Алерт: Туман на перевале');
  });

  it('жёлтое место у вулкана с зелёным KVERT: ЗЕЛЁНЫЙ только в строке KVERT, не в скобках и без «значит»', async () => {
    const out = await guardianGreen({
      recommender_status: 'yellow', volcano_acc: 'green', volcano_observed_at: new Date(Date.now() - 3_600_000).toISOString(),
    });
    expect(headerOf(out)).toContain('[ЖЁЛТЫЙ]');
    expect(out).toMatch(/KVERT: ЗЕЛЁНЫЙ/);
    expect(out).not.toContain('ЗЕЛЁНЫЙ значит');
  });
});

describe('правило 5: МЧС — обязательной только там, где так сказано', () => {
  const base = {
    difficulty: null, distance_km: null, elevation_gain_m: null, duration_hours: null, season: null,
    hazards: null, equipment: null, mchs_phone: null, park_name: null,
  };

  it('маршрут: true — «ОБЯЗАТЕЛЬНА», null и false — ни слова об обязательности', () => {
    expect(routeFacts({ ...base, mchs_registration_required: true }).join('\n')).toContain('ОБЯЗАТЕЛЬНА');
    for (const v of [null, false]) {
      expect(routeFacts({ ...base, mchs_registration_required: v }).join('\n'), String(v)).not.toMatch(/ОБЯЗАТЕЛЬНА|обязательн/i);
    }
  });

  it('место: true — «Регистрация группы в МЧС: требуется», иначе строки нет', () => {
    const p = { name: 'Озеро Тихое', description: null, category: null, district: null };
    expect(placeFactLines({ ...p, registration_required: true })).toContain('Регистрация группы в МЧС: требуется');
    for (const v of [null, false]) expect(placeFactLines({ ...p, registration_required: v }).join('\n'), String(v)).not.toMatch(/МЧС/);
  });

  it('get_guardian_context: регистрация, записанная у самого места, — та же строка, что у get_place_info', async () => {
    expect(await guardianGreen({ registration_required: true })).toContain('Регистрация группы в МЧС: требуется');
    for (const v of [null, false]) expect(await guardianGreen({ registration_required: v }), String(v)).not.toContain('Регистрация группы в МЧС');
  });

  it('маршруты места без обязательной регистрации — «не значит, что она не нужна»; с обязательной — этой строки нет', () => {
    for (const v of [null, false]) {
      expect(routeFactsLines([route({ mchs_registration_required: v })]).join('\n'), String(v)).toContain('не значит, что она не нужна');
    }
    expect(routeFactsLines([route({ mchs_registration_required: true })]).join('\n')).not.toContain('не нужна');
    expect(SERVER_INSTRUCTIONS).toMatch(/112/);
  });
});

describe('правило 6: заявка — только с согласием человека', () => {
  it('у каждого пишущего инструмента consent обязателен и булев; все пять названы в инструкции', () => {
    expect(WRITE_TOOL_NAMES.size).toBeGreaterThan(0);
    for (const name of WRITE_TOOL_NAMES) {
      const tool = PUBLIC_MCP_TOOLS.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      const schema = tool!.inputSchema as { required?: string[]; properties: Record<string, { type?: string }> };
      expect(schema.required, name).toContain('consent');
      expect(schema.properties.consent?.type, name).toBe('boolean');
      expect(SERVER_INSTRUCTIONS, name).toContain(name);
    }
  });
});

describe('правило 7: ключ статуса', () => {
  it.each([['request' as const], ['stay' as const]])('keyLine(%s): согласие подтверждает сам человек, ключ и ссылку не публиковать', (kind) => {
    const line = keyLine('k', kind);
    expect(line).toContain('get_request_status');
    expect(line).toContain('сам подтверждает согласие');
    expect(line).toContain('Ключ и ссылку не публикуйте');
    expect(SERVER_INSTRUCTIONS).toContain('Ключ и ссылку не публикуй');
  });
});

describe('правило 8: оплата', () => {
  const RENT_STAY = 'машина под заказ, прокат и жильё через платформу не оплачиваются';

  it('по выключателю: выключен — «не принимает», включён — ни «не принимает», ни «напрямую»; машина, прокат и жильё — в обоих', () => {
    const off = buildServerInstructions({ acceptsPayments: false });
    const on = buildServerInstructions({ acceptsPayments: true });
    expect(off).toContain('не принимает');
    expect(on).not.toContain('не принимает');
    expect(on).not.toContain('напрямую');
    // Слова — как на странице статуса заявки («Оператор скажет, как оплатить»):
    // ссылки на оплату ни один ответ сейчас не выдаёт.
    expect(on).toContain('только после подтверждения оператором; как оплатить, скажет он');
    expect(paymentRule(true)).not.toMatch(/ссылк/);
    expect(off).toContain(RENT_STAY);
    expect(on).toContain(RENT_STAY);
    expect(paymentRule(true)).toContain(RENT_STAY);
    expect(SERVER_INSTRUCTIONS).toBe(buildServerInstructions({ acceptsPayments: platformAcceptsPayments() }));
  });

  it('машину, прокат и жильё «не оплачивает платформа» говорят и сами пишущие инструменты', () => {
    for (const t of [REQUEST_CHARTER_TOOL, CAR_RENTAL_REQUEST_TOOL, STAY_REQUEST_TOOL]) {
      expect(t.description, t.name).toMatch(/оплаты через платформу нет|через платформу [^.]*не оплачивается/i);
    }
  });

  it('о туре — то же, что ответ запроса мест и описание create_booking_request при нынешнем выключателе', () => {
    // Включение оплаты — видимый коммит (lib/payments/accepting.ts): тогда
    // эта проверка краснеет, пока описание инструмента говорит «оплаты нет».
    const noPay = /оплаты через платформу нет/;
    if (platformAcceptsPayments()) {
      expect(BOOKING_REQUEST_TOOL.description).not.toMatch(noPay);
    } else {
      expect(BOOKING_REQUEST_TOOL.description).toMatch(noPay);
      for (const w of ['не принимает', 'напрямую']) {
        expect(seatRequestPaymentNote(), w).toContain(w);
        expect(SERVER_INSTRUCTIONS, w).toContain(w);
      }
    }
  });
});

describe('имена в инструкции — настоящие инструменты и параметры', () => {
  const propertyNames = new Set(PUBLIC_MCP_TOOLS.flatMap((t) =>
    Object.keys((t.inputSchema as { properties?: object }).properties ?? {})));
  const known = (w: string) => PUBLIC_MCP_TOOL_NAMES.has(w) || propertyNames.has(w);

  it('каждое snake_case-имя — публичный инструмент или параметр', () => {
    const names = new Set(SERVER_INSTRUCTIONS.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? []);
    expect(names.size).toBeGreaterThan(5);
    expect([...names].filter((n) => !known(n))).toEqual([]);
  });

  it('латиница в пронумерованных правилах — инструмент, параметр или литерал true', () => {
    const rules = SERVER_INSTRUCTIONS.split('\n').filter((l) => /^\d+\. /.test(l));
    expect(rules.length).toBeGreaterThanOrEqual(8);
    const words = new Set(rules.join('\n').match(/\b[a-z][a-z0-9_]*\b/g) ?? []);
    expect([...words].filter((w) => !known(w) && w !== 'true')).toEqual([]);
  });
});

// ── 3. Запреты — по выходу ───────────────────────────────────────────────────

describe('запреты по тексту инструкции', () => {
  it.each([
    ['выключатель выключен', buildServerInstructions({ acceptsPayments: false })],
    ['выключатель включён', buildServerInstructions({ acceptsPayments: true })],
  ])('%s: телефонов, кроме 112, нет; ID-номеров нет; эмодзи нет', (_, text) => {
    // Пять цифр и больше подряд или через пробел, дефис, скобку, плюс —
    // телефон или номер тура, которому в сквозных правилах не место.
    expect(text).not.toMatch(/\d(?:[\s\-()+]*\d){4,}/);
    expect(text).toContain('112');
    expect(text).not.toMatch(/ID\d/);
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    // Цитата — только в «ёлочках»: их сверяет таблица производителей выше,
    // а фраза в других кавычках прошла бы мимо неё (ревью 29.10).
    expect(text).not.toMatch(/["“”„‘’']/);
  });

  it.each([false, true])('оплата %s: не длиннее 2048 знаков — дальше Claude Code режет хвост', (acceptsPayments) => {
    // Claude Code 2.1.84: «server instructions are now capped at 2KB»;
    // 2.1.280 — «2,048-character cap»; 2.1.296 поднял до 4096. Пользователи
    // версий между ними получили бы инструкцию без правила 8 и строки
    // проката. Потолок, а не цель: рост значит, что правило одного
    // инструмента переехало сюда — его место в описании инструмента.
    expect(buildServerInstructions({ acceptsPayments }).length).toBeLessThanOrEqual(2048);
  });
});
