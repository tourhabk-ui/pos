/**
 * Отказ заявке ИИ-агента по входу (слово владельца 13.11: «как Кузьмич
 * запрашивает согласие, может, согласие не доходит? нужна проверка и в случае
 * дыры необходимо решение»).
 *
 * Пробный прогон того дня нашёл три дыры в отказах пишущих инструментов:
 *   1. отказ только по-русски — а в журнале китайские и английские агенты;
 *   2. назывался первый отказ, а не все: `consent: false` с выдуманным
 *      телефоном давали ответ только про телефон;
 *   3. поле не называлось («Invalid input: expected string, received
 *      undefined»), а поле под чужим именем молча отбрасывалось.
 *
 * Здесь — вызовом роута /api/mcp: что на деле получает агент и что ложится в
 * журнал вызовов. Чистые правила сборщика — в начале файла.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import type { CharterCarrier } from '@/lib/transfers/charter-format';

const { createLeadMock, query, seatRequestMock, sendPdAlertMock, partnerNotifyMock, personalNotifyMock, avail } = vi.hoisted(() => ({
  createLeadMock: vi.fn(async (_: Record<string, unknown>) => 'lead-1' as string | null),
  query: vi.fn(),
  seatRequestMock: vi.fn(),
  sendPdAlertMock: vi.fn(),
  partnerNotifyMock: vi.fn(async () => ({ state: 'no_channel' })),
  personalNotifyMock: vi.fn(async () => ({ state: 'no_channel' })),
  avail: { remaining: 10, keepsSchedule: true },
}));

vi.mock('@/lib/leads/create', () => ({
  createLead: (p: Record<string, unknown>) => createLeadMock(p),
  createLeadDetailed: async (p: Record<string, unknown>) => { const id = await createLeadMock(p); return id ? { id, created: true } : null; },
  findRecentLeadByCommentPrefix: async () => null,
}));
vi.mock('@/lib/kuzmich/core', () => ({ executeKuzmichTool: async () => 'ok' }));
vi.mock('@/lib/planner', () => ({
  createPlannerCache: () => ({}),
  fetchAvailabilityForTour: async (_id: string, from: string) => [{ date: from, remaining: avail.remaining, priceOverride: null }],
}));
vi.mock('@/lib/seat-requests/service', () => ({
  createSeatRequest: (...a: unknown[]) => seatRequestMock(...a),
  statusUrl: (t: string) => `https://vedarai.ru/seat/${t}`,
  tourKeepsSchedule: async () => avail.keepsSchedule,
}));
vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: (p: unknown) => sendPdAlertMock(p) }));
vi.mock('@/lib/notifications/partner-request-notify', () => ({ notifyPartnerRequestPersonally: (...a: unknown[]) => partnerNotifyMock(...(a as [])) }));
vi.mock('@/lib/notifications/lead-notify', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  notifyPartnerNewLeadPersonally: (...a: unknown[]) => personalNotifyMock(...(a as [])),
}));
vi.mock('@/lib/db-pool', () => ({ pool: { query, connect: async () => ({ query, release: () => {} }) } }));
// Машина прайса — с кузовом и видом вождения, как в настоящей строке: поиск
// машины по словам читает оба поля, и без них «машины нет в прайсе» падал бы
// внутренней ошибкой подставных данных, а не отвечал словами.
vi.mock('@/lib/rental/rental', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadRentalCompanies: async () => [{
    slug: 'test-prokat', name: 'Тест Прокат',
    offers: [{ title: 'Suzuki Jimny', bodyKind: 'suv', driver: 'self', transmission: null, drive: null, priceRubPerDay: 5000, priceIsFrom: false, depositRub: 10000 }],
  }],
}));
const priceLine = (to: string, priceRub: number) => ({ from: 'Петропавловск-Камчатский', to, priceRub, note: null, conditions: null, validYear: 2026 });
const CARRIER = {
  partnerId: 'partner-1', slug: 'shatun', name: 'Шатун', shortDescription: null, logo: null,
  vehicles: [{ kind: 'vahtovka', title: 'КамАЗ-1', seats: 26 }],
  destinations: [priceLine('Вулкан Авачинский', 65000)],
  extraDay: null, rates: [], seatClasses: [],
  photos: [], clips: [], legal: null, video: null,
  phone: '+79001112233', telegramHref: null, whatsappHref: null,
} as unknown as CharterCarrier;
vi.mock('@/lib/transfers/charter', () => ({ loadCharterCarriers: async () => [CARRIER] }));

import { POST } from '@/app/api/mcp/route';
import {
  CONSENT_ALSO_NOTE, REQUEST_NOT_CHANGED, argsRefusalEn, consentCase, consentProblem, inputRefusalText, phoneProblem,
  problemsFromIssues, unknownFields,
} from '@/lib/mcp/input-refusal';
import { NO_CONSENT_MESSAGE } from '@/lib/mcp/write-guard';
import { validateToolArgs } from '@/lib/kuzmich/tool-schemas';

const TOUR = { id: 27, title: 'Сплав по реке Быстрая', operator_id: 'op-uuid-1', base_price: 13000, price_unit: 'person', nearest_free_date: null };
const STAY_ID = '3b2551c7-ed5c-47c8-bb93-41ca6a278c1e';
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

let ip = 0;
async function call(name: string, args: Record<string, unknown>) {
  ip += 1;
  const res = await POST(new NextRequest('http://localhost/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': `10.9.${Math.floor(ip / 250)}.${ip % 250}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }));
  const result = (await res.json()).result as { isError?: boolean; content: Array<{ text: string }> };
  return { isError: result.isError === true, text: result.content[0]?.text ?? '' };
}

const PERSON = { name: 'Иван Петров', phone: '+79001234567', consent: true };
const DATE = inDays(30);
const ARGS: Record<string, Record<string, unknown>> = {
  create_lead: { ...PERSON, comment: 'Хотим на вулкан в августе, 4 человека, бюджет 200000 руб' },
  create_booking_request: { ...PERSON, tour: '27', date: DATE, participants: 2 },
  create_stay_request: { ...PERSON, accommodation: STAY_ID, check_in: DATE, check_out: inDays(32), guests: 2 },
  request_charter: { ...PERSON, destination: 'Вулкан Авачинский', date_from: DATE, passengers: 4 },
};
const UPFRONT = Object.keys(ARGS);

const WRITE_SQL = /INSERT INTO (leads|stay_requests|seat_requests|agent_request_keys|agent_request_notify|mcp_write_attempts|pd_consents)|UPDATE leads/i;
/**
 * Заявки нет: ни лида, ни запроса мест, ни записи в базе. Уведомления партнёру
 * здесь не сверяются намеренно: они уходят после создания лида и не ждутся
 * ответом, поэтому в этот тест долетают от соседнего, где заявка создана. Что
 * проба и отказ никому не пишут, держит mcp-write-contract.
 */
const nothingSent = () => {
  expect(createLeadMock).not.toHaveBeenCalled();
  expect(seatRequestMock).not.toHaveBeenCalled();
  // Отказ согласия пишет строку допуска без ПД (сторож записи) — это не заявка.
  expect(query.mock.calls.filter(([sql]) => WRITE_SQL.test(String(sql)) && !/mcp_write_attempts/.test(String(sql)))).toEqual([]);
};

/** Код причины последнего вызова в журнале mcp_tool_calls. */
async function journalCode(): Promise<unknown> {
  let row: unknown[] | undefined;
  await vi.waitFor(() => {
    row = query.mock.calls.filter(([sql]) => /INSERT INTO mcp_tool_calls/.test(String(sql))).at(-1)?.[1] as unknown[] | undefined;
    expect(row).toBeDefined();
  });
  return row?.[7];
}

/** Половины отказа: русская до пустой строки, английская после. */
function halves(text: string): { ru: string; en: string } {
  const at = text.indexOf('\n\nRequest not created');
  expect(at, text).toBeGreaterThan(0);
  return { ru: text.slice(0, at), en: text.slice(at + 2) };
}
const bullets = (s: string) => s.split('\n').filter((l) => l.startsWith('• ')).map((l) => l.slice(2, l.indexOf(' — ')));

beforeEach(() => {
  process.env.MCP_HASH_SALT = 'соль-для-теста';
  avail.remaining = 10;
  avail.keepsSchedule = true;
  for (const m of [createLeadMock, seatRequestMock, sendPdAlertMock, partnerNotifyMock, personalNotifyMock]) m.mockClear();
  sendPdAlertMock.mockResolvedValue({ delivered: true, channel: 'max', reason: 'доставлено в MAX' });
  query.mockReset().mockImplementation(async (sql: string) => {
    if (/COUNT\(\*\)/.test(sql)) return { rows: [{ a: '0', b: '0', c: '0' }] };
    if (/FROM operator_tours/.test(sql)) return { rows: [TOUR] };
    if (/AS has_site/.test(sql)) return { rows: [{ id: STAY_ID, name: 'Кутха', has_site: false, has_rooms: false, has_phone: true }] };
    return { rows: [] };
  });
});

// ── Сборщик: чистые правила ──────────────────────────────────────────────────

describe('сборщик отказа', () => {
  const schema = z.object({
    tour: z.string().trim().min(1, 'Укажите тур'),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате YYYY-MM-DD'),
    people: z.number().int().min(1).max(50).optional(),
    name: z.string().min(2).max(10),
    consent: z.boolean(),
  });
  const problems = (raw: Record<string, unknown>) => {
    const parsed = schema.safeParse(raw);
    return parsed.success ? [] : problemsFromIssues(parsed.error.issues, raw);
  };

  it('пропавшее поле названо, стандартной строки Zod в отказе нет', () => {
    const p = problems({ date: '2027-01-01', name: 'Иван', consent: true });
    expect(p).toEqual([{ field: 'tour', ru: 'обязательное поле, в запросе его нет', en: 'required field is missing', own: false }]);
    expect(inputRefusalText(p)).not.toMatch(/Invalid input|expected string|received undefined/);
  });

  it('свои слова схемы остаются по-русски, по-английски — род ошибки; все поля разом, по одному на поле', () => {
    const p = problems({ tour: '', date: 'завтра', people: 0, name: 'И', consent: true });
    expect(p.map((x) => x.field)).toEqual(['tour', 'date', 'people', 'name']);
    expect(p[0]).toMatchObject({ ru: 'Укажите тур', en: 'too short (at least 1 characters)', own: true });
    expect(p[1]).toMatchObject({ ru: 'Дата в формате YYYY-MM-DD', en: 'invalid format', own: true });
    expect(p[2]).toMatchObject({ ru: 'слишком маленькое (не меньше 1)', en: 'too small (at least 1)', own: false });
    expect(p[3]).toMatchObject({ ru: 'слишком короткое (не меньше 2 знаков)', en: 'too short (at least 2 characters)' });
    expect(problems({ tour: 'т', date: '2027-01-01', people: 'двое', name: 'Оченьдлинноеимя', consent: true })).toMatchObject([
      { field: 'people', ru: 'должно быть числом', en: 'must be a number' },
      { field: 'name', ru: 'слишком длинное (не больше 10 знаков)', en: 'too long (at most 10 characters)' },
    ]);
  });

  it('слова схемы, начатые именем поля, имя не повторяют', () => {
    const named = z.object({ notify_url: z.string().url('notify_url: адрес приёмника — https-ссылкой') });
    const raw = { notify_url: 'не адрес' };
    const parsed = named.safeParse(raw);
    const p = parsed.success ? [] : problemsFromIssues(parsed.error.issues, raw);
    expect(p).toMatchObject([{ field: 'notify_url', ru: 'адрес приёмника — https-ссылкой', own: true }]);
    expect(inputRefusalText(p)).toContain('• notify_url — адрес приёмника — https-ссылкой');
    expect(inputRefusalText(p)).not.toContain('notify_url — notify_url');
  });

  it('согласие — три разных случая и свои слова у каждого', () => {
    expect(consentCase(true)).toBeNull();
    expect([consentCase(undefined), consentCase(null), consentCase(false), consentCase('true'), consentCase(1)])
      .toEqual(['missing', 'missing', 'refused', 'not_boolean', 'not_boolean']);
    const base = { tour: 'т', date: '2027-01-01', name: 'Иван' };
    expect(problems(base)[0]).toMatchObject({ field: 'consent', en: expect.stringContaining('the consent field is missing') });
    expect(problems({ ...base, consent: 'true' })[0]).toMatchObject({ field: 'consent', ru: expect.stringContaining('логическим значением') });
    expect(consentProblem('refused').ru).toContain('нет согласия на обработку персональных данных (consent: false)');
    expect(consentProblem('refused').en).toContain('no consent to personal-data processing (consent: false)');
  });

  it('текст: сперва русский, затем английский, строк поровну; заголовок говорит «всё из списка» при нескольких', () => {
    const one = inputRefusalText([phoneProblem('bad')]);
    expect(one.split('\n')[0]).toBe('Заявка не создана — исправьте и повторите вызов:');
    expect(one).toContain('Request not created — fix this and call again:');
    const two = inputRefusalText([phoneProblem('implausible'), consentProblem('refused')], ['tour_id']);
    const { ru, en } = halves(two);
    expect(ru.split('\n')[0]).toBe('Заявка не создана — исправьте всё из списка и повторите вызов:');
    expect(en.split('\n')[0]).toBe('Request not created — fix everything listed and call again:');
    expect(bullets(ru)).toEqual(['phone', 'consent']);
    expect(bullets(en)).toEqual(['phone', 'consent']);
    expect(ru).toContain('поля, которых у инструмента нет: tour_id');
    expect(en).toContain('Unknown fields in the request: tour_id');
    // Английская половина — латиницей: русских слов в ней нет.
    expect(en).not.toMatch(/[а-яё]/i);
  });

  it('лишние поля: служебное test не называется, список не длиннее восьми', () => {
    expect(unknownFields({ tour: 1, tour_id: 2, test: true, Tour: 3 }, ['tour', 'date'])).toEqual(['tour_id', 'Tour']);
    const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`x${i}`, 1]));
    expect(unknownFields(many, [])).toHaveLength(8);
  });

  it('лишние поля: в отказ идёт только похожее на имя поля — ни текста, ни телефона, ни ключа в килобайт', () => {
    const raw = { tour_id: 1, 'Иван Петров +79001234567': 1, 'a b': 1, ['x'.repeat(41)]: 1, '<script>': 1, '1st': 1, ok_field_2: 1 };
    expect(unknownFields(raw, [])).toEqual(['tour_id', 'ok_field_2']);
  });

  it('заголовок говорит, что не случилось: заявка не создана или не изменена', () => {
    const changed = inputRefusalText([phoneProblem('bad')], [], REQUEST_NOT_CHANGED);
    expect(changed.split('\n')[0]).toBe('Заявка не изменена — исправьте и повторите вызов:');
    expect(changed).toContain('Request not changed — fix this and call again:');
    expect(changed).not.toContain('не создана');
  });

  it('слова схемы, начатые «поле — », имя тоже не повторяют', () => {
    const s2 = z.object({ action: z.enum(['cancel', 'change_date'], { error: 'action — cancel или change_date' }) });
    const raw = { action: 'delete' };
    const parsed = s2.safeParse(raw);
    const p = parsed.success ? [] : problemsFromIssues(parsed.error.issues, raw);
    expect(p).toMatchObject([{ field: 'action', ru: 'cancel или change_date' }]);
  });

  it('своё правило схемы: «пропало» — только с пометкой; без неё поле под синонимом пропавшим не названо', () => {
    const rule = (missing: boolean) => z.object({ tours: z.string().optional(), ids: z.string().optional() })
      .refine(() => false, { path: ['tours'], ...(missing ? { params: { missing: true } } : {}), message: 'нужно 2–4 тура' });
    const raw = { ids: '61' };
    const issuesOf = (missing: boolean) => { const r = rule(missing).safeParse(raw); return r.success ? [] : r.error.issues; };
    expect(problemsFromIssues(issuesOf(true), raw)).toMatchObject([{ field: 'tours', ru: 'нужно 2–4 тура', en: 'required field is missing' }]);
    expect(problemsFromIssues(issuesOf(false), raw)).toMatchObject([{ field: 'tours', ru: 'нужно 2–4 тура', en: 'invalid value' }]);
  });

  it('общий отказ без согласия — тем же сборщиком: поле названо, оба языка', () => {
    const { ru, en } = halves(NO_CONSENT_MESSAGE);
    expect(bullets(ru)).toEqual(['consent']);
    expect(bullets(en)).toEqual(['consent']);
    expect(NO_CONSENT_MESSAGE).toContain('нет согласия на обработку персональных данных');
    expect(CONSENT_ALSO_NOTE).toMatch(/^И ещё: нет согласия[^\n]+\nAlso: no consent[^\n]+$/);
  });
});

// ── Пишущие инструменты: что получает агент ─────────────────────────────────

describe('отказ называет всё разом и на двух языках', () => {
  for (const tool of UPFRONT) {
    it(`${tool}: телефон-мусор и consent: false — в одном отказе оба поля`, async () => {
      const r = await call(tool, { ...ARGS[tool], phone: 'привет', consent: false });
      expect(r.isError).toBe(true);
      const { ru, en } = halves(r.text);
      expect(bullets(ru)).toEqual(['phone', 'consent']);
      expect(bullets(en)).toEqual(['phone', 'consent']);
      expect(ru).toContain('не похож на номер');
      expect(en).toContain('does not look like a phone number');
      expect(en).toContain('no consent to personal-data processing');
      expect(await journalCode()).toBe('bad_phone');
      nothingSent();
    });

    it(`${tool}: номер, которого не бывает, и consent: false — оба поля; подсказка про test: true осталась`, async () => {
      const r = await call(tool, { ...ARGS[tool], phone: '+70000000000', consent: false });
      expect(r.isError).toBe(true);
      const { ru, en } = halves(r.text);
      expect(bullets(ru)).toEqual(['phone', 'consent']);
      expect(bullets(en)).toEqual(['phone', 'consent']);
      expect(ru).toMatch(/такого номера не бывает/);
      expect(r.text).toMatch(/test: true/);
      expect(await journalCode()).toBe('implausible_phone');
      nothingSent();
    });

    it(`${tool}: только consent: false — отказ с именем поля на двух языках, в журнале no_consent`, async () => {
      const r = await call(tool, { ...ARGS[tool], consent: false });
      expect(r.isError).toBe(true);
      expect(r.text).toBe(NO_CONSENT_MESSAGE);
      // До 13.11 отказ согласия ложился в журнал под общим write_guard —
      // неотличимо от лимита заявок с адреса.
      expect(await journalCode()).toBe('no_consent');
      nothingSent();
    });

    it(`${tool}: годный номер и согласие — отказа нет`, async () => {
      const r = await call(tool, ARGS[tool]);
      expect(r.isError, r.text).toBe(false);
      expect(r.text).not.toContain('Request not created');
    });
  }

  it('проба (test: true) без согласия — тот же отказ и тот же код в журнале', async () => {
    const r = await call('create_lead', { ...ARGS.create_lead, consent: false, test: true });
    expect(r.isError).toBe(true);
    expect(r.text).toBe(NO_CONSENT_MESSAGE);
    expect(await journalCode()).toBe('no_consent');
    nothingSent();
  });

  it('несколько ошибок схемы разом: нет имени, дата не датой, согласия нет — названы все три', async () => {
    const { name: _name, consent: _consent, ...rest } = ARGS.create_booking_request;
    const r = await call('create_booking_request', { ...rest, date: 'завтра' });
    expect(r.isError).toBe(true);
    const { ru, en } = halves(r.text);
    expect(new Set(bullets(ru))).toEqual(new Set(['date', 'name', 'consent']));
    expect(new Set(bullets(en))).toEqual(new Set(['date', 'name', 'consent']));
    expect(ru).toContain('в запросе нет поля consent');
    expect(en).toContain('the consent field is missing');
    expect(r.text).not.toMatch(/Invalid input|received undefined/);
    nothingSent();
  });

  it('поле под чужим именем: tour_id вместо tour — названо пропавшее поле и лишнее', async () => {
    const { tour: _tour, ...rest } = ARGS.create_booking_request;
    const r = await call('create_booking_request', { ...rest, tour_id: 27 });
    expect(r.isError).toBe(true);
    const { ru, en } = halves(r.text);
    expect(bullets(ru)).toEqual(['tour']);
    expect(ru).toContain('поля, которых у инструмента нет: tour_id');
    expect(en).toContain('Unknown fields in the request: tour_id');
    expect(r.text).not.toMatch(/Invalid input|received undefined/);
    expect(await journalCode()).toBe('invalid_args:tour');
    nothingSent();
  });

  it('лишнее поле без пропавшего — не ошибка: заявка проходит', async () => {
    const r = await call('create_booking_request', { ...ARGS.create_booking_request, source: 'my-agent' });
    expect(r.isError, r.text).toBe(false);
  });

  it('ошибка схемы и негодный телефон разом: названы и поле схемы, и телефон, и согласие', async () => {
    const r = await call('request_charter', { ...ARGS.request_charter, date_from: 'скоро', phone: '+70000000000', consent: false });
    expect(r.isError).toBe(true);
    expect(new Set(bullets(halves(r.text).ru))).toEqual(new Set(['date_from', 'phone', 'consent']));
    expect(new Set(bullets(halves(r.text).en))).toEqual(new Set(['date_from', 'phone', 'consent']));
    nothingSent();
  });

  it('«нет мест» при consent: false называет и согласие — второго отказа не будет', async () => {
    avail.remaining = 0;
    // «Нет мест» — ответ, а не отказ: заявка не создана, но это не ошибка входа.
    const r = await call('create_booking_request', { ...ARGS.create_booking_request, consent: false });
    expect(r.text).toMatch(/нет свободных мест — заявка не создана/);
    expect(r.text.endsWith(CONSENT_ALSO_NOTE)).toBe(true);
    // С согласием приписки нет.
    const withConsent = await call('create_booking_request', ARGS.create_booking_request);
    expect(withConsent.text).toMatch(/нет свободных мест — заявка не создана/);
    expect(withConsent.text).not.toContain('Also: no consent');
    nothingSent();
  });

  it('отказ по делу (тур не найден) при consent: false называет и согласие', async () => {
    query.mockImplementation(async (sql: string) => (/COUNT\(\*\)/.test(sql) ? { rows: [{ a: '0', b: '0', c: '0' }] } : { rows: [] }));
    const r = await call('create_booking_request', { ...ARGS.create_booking_request, tour: 'несуществующий тур', consent: false });
    expect(r.text).not.toContain('Request not created');
    expect(r.text.endsWith(CONSENT_ALSO_NOTE)).toBe(true);
    const withConsent = await call('create_booking_request', { ...ARGS.create_booking_request, tour: 'несуществующий тур' });
    expect(withConsent.text).not.toContain('Also: no consent');
    nothingSent();
  });

  it('создана заявка — приписки о согласии нет ни при каком ответе', async () => {
    const r = await call('create_booking_request', ARGS.create_booking_request);
    expect(r.isError, r.text).toBe(false);
    expect(r.text).not.toContain('Also: no consent');
    expect(createLeadMock).toHaveBeenCalledTimes(1);
  });
});

describe('прокат: consent: false на первом шаге — черновик, а не отказ', () => {
  const base = { ...PERSON, car: 'Suzuki Jimny', date_from: DATE, date_to: inDays(33) };

  it('шаг 1 с consent: false проходит и отдаёт код; про согласие как про ошибку не сказано', async () => {
    const r = await call('create_car_rental_request', { ...base, consent: false });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).not.toContain('Request not created');
    expect(r.text).not.toContain('Also: no consent');
    nothingSent();
  });

  it('негодный телефон на шаге 1 — в отказе один телефон, согласия в списке нет', async () => {
    for (const phone of ['привет', '+70000000000']) {
      const r = await call('create_car_rental_request', { ...base, phone, consent: false });
      expect(r.isError, phone).toBe(true);
      expect(bullets(halves(r.text).ru)).toEqual(['phone']);
      expect(bullets(halves(r.text).en)).toEqual(['phone']);
    }
    nothingSent();
  });

  it('ответ по делу на шаге 1 (дата уже прошла) согласие не приписывает: без него шаг и задуман', async () => {
    const r = await call('create_car_rental_request', { ...base, date_from: inDays(-3), consent: false });
    expect(r.text).toMatch(/уже прошла — заявка не создана/);
    expect(r.text).not.toContain('Also: no consent');
    expect(r.text).not.toContain('И ещё: нет согласия');
    nothingSent();
  });

  it('машины нет в прайсе — ответ словами со списком машин и без приписки о согласии', async () => {
    const r = await call('create_car_rental_request', { ...base, car: 'Луноход', consent: false });
    expect(r.text).toMatch(/нет в прайсе «Тест Прокат»/);
    expect(r.text).toMatch(/Suzuki Jimny/);
    expect(r.text).not.toContain('Also: no consent');
  });

  it('пропавшее поле названо и у проката', async () => {
    const { car: _car, ...rest } = base;
    const r = await call('create_car_rental_request', { ...rest, consent: false, vehicle: 'Suzuki Jimny' });
    expect(r.isError).toBe(true);
    expect(bullets(halves(r.text).ru)).toEqual(['car']);
    expect(r.text).toContain('Unknown fields in the request: vehicle');
  });
});

// ── Читающие инструменты ─────────────────────────────────────────────────────

describe('читающий инструмент: поле названо, рядом английская половина', () => {
  it('валидатор называет поле и там, где у схемы нет своих слов', () => {
    const v = validateToolArgs('search_kamchatka', {});
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.error).toContain('query — обязательное поле, в запросе его нет');
    expect(v.error).not.toMatch(/Invalid input|received undefined/);
    expect(v.problems).toEqual([{ field: 'query', ru: 'обязательное поле, в запросе его нет', en: 'required field is missing', own: false }]);
  });

  it('свои слова схемы имя поля не дублируют; английская строка называет поле и что оно пропало', () => {
    const v = validateToolArgs('get_tour_availability', { when: 'завтра' } as Record<string, string>);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.error).toBe('Аргументы для get_tour_availability не прошли проверку: нужно указать tour (название, ключевое слово или ID тура). Повтори вызов с корректными аргументами.');
    expect(argsRefusalEn(v.problems)).toBe('Arguments failed validation — fix and call again:\n• tour — required field is missing');
    expect(argsRefusalEn([])).toMatch(/^Arguments failed validation/);
  });

  it('сравнение туров: один тур под синонимом — по-русски причина схемы, по-английски не «поле пропало»', () => {
    const v = validateToolArgs('compare_tours', { tour_ids: '61' } as Record<string, string>);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.problems).toHaveLength(1);
    expect(v.problems[0]).toMatchObject({ field: 'tours', own: true, en: 'invalid value' });
  });

  it('через /api/mcp: отказ читающему инструменту — на двух языках и с именем поля', async () => {
    const r = await call('get_tour_availability', { when: 'завтра' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('нужно указать tour');
    expect(r.text).toContain('Arguments failed validation — fix and call again:\n• tour — required field is missing');
    expect(await journalCode()).toBe('invalid_args');
  });
});


// ── Отмена и перенос заявки ──────────────────────────────────────────────────

describe('change_request: негодные поля — все разом, с именами, на двух языках', () => {
  const KEY = 'A'.repeat(32);

  it('действие не из списка и дата не датой — оба поля в одном отказе; заявка «не изменена»', async () => {
    const r = await call('change_request', { key: KEY, action: 'delete', date: '18.07.2027' });
    expect(r.isError).toBe(true);
    const at = r.text.indexOf('\n\nRequest not changed');
    expect(at, r.text).toBeGreaterThan(0);
    const ru = r.text.slice(0, at);
    const en = r.text.slice(at + 2);
    expect(ru.split('\n')[0]).toBe('Заявка не изменена — исправьте всё из списка и повторите вызов:');
    expect(bullets(ru)).toEqual(['action', 'date']);
    expect(bullets(en)).toEqual(['action', 'date']);
    expect(ru).not.toContain('action — action');
    expect(await journalCode()).toBe('invalid_args:action');
    nothingSent();
  });

  it('действия нет вовсе — поле названо', async () => {
    const r = await call('change_request', { key: KEY });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^• action — /m);
    expect(r.text).toContain('Request not changed — fix this and call again:');
    expect(r.text).not.toMatch(/Invalid input|received undefined/);
  });
});
