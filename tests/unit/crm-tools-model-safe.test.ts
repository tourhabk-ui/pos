/**
 * Сторож инструментов CRM для модели (CRM #2325, шаг 1д).
 *
 * Ответ инструмента уходит зарубежной модели целиком (§8, 152-ФЗ), поэтому
 * правило владельца для CRM-инструментов проверяется ИСПОЛНЕНИЕМ, а не
 * чтением исходника: каждый инструмент гоняется на данных, где телефон, почта
 * и полное имя вписаны во ВСЕ текстовые поля — имя клиента, заметку, метки,
 * заголовки событий и задач, название и даты источника, имя человека в брони.
 * На выходе — только `contact_id`, подпись «Анна П.» и текст без телефонов и
 * почт.
 *
 * Держит ещё:
 *  - скоуп партнёра — из контекста, а не из аргументов модели;
 *  - доступ без права записи в базу не пишет и пишущих инструментов не видит;
 *  - запись подписана Кузьмичом (лента, задача, выполнение);
 *  - отказ базы — названный отказ с SQLSTATE в логе, а не «ничего нет»;
 *  - своего SQL у инструментов нет: те же функции, что у экрана кабинета;
 *  - в публичный реестр Кузьмича (= публичный MCP) инструменты CRM не попали.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

const listContacts = vi.fn();
const getContactCard = vi.fn();
const addContactTouch = vi.fn();
const createTask = vi.fn();
const completeTask = vi.fn();
const listTasks = vi.fn();
const loadInbox = vi.fn();

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));
vi.mock('@/lib/crm/contact-queries', () => ({
  listContacts: (...a: unknown[]) => listContacts(...a),
  getContactCard: (...a: unknown[]) => getContactCard(...a),
}));
vi.mock('@/lib/crm/events', () => ({ addContactTouch: (...a: unknown[]) => addContactTouch(...a) }));
vi.mock('@/lib/crm/tasks', () => ({
  createTask: (...a: unknown[]) => createTask(...a),
  completeTask: (...a: unknown[]) => completeTask(...a),
  listTasks: (...a: unknown[]) => listTasks(...a),
}));
vi.mock('@/lib/crm/inbox', () => ({ loadInbox: (...a: unknown[]) => loadInbox(...a) }));

const tools = await import('@/lib/crm/tools');
const { hasPII } = await import('@/lib/security/pii-redact');

const NOW = Date.parse('2026-10-10T00:00:00Z'); // 12:00 10.10 по Камчатке
const P = 'aaaaaaaa-0000-4000-8000-000000000001';
const C = 'cccccccc-0000-4000-8000-000000000001';
const T = 'dddddddd-0000-4000-8000-000000000001';
const U = 'bbbbbbbb-0000-4000-8000-000000000001';

const PHONE = '+7 914 111-22-33';
const EMAIL = 'anna.petrova@mail.ru';
const FULL = 'Анна Петрова';
const DIRTY = `${FULL}, ${PHONE}, ${EMAIL}`;

const CTX = { partnerId: P, category: 'operator' as const, userId: U, actor: 'kuzmich' as const, canWrite: true, nowMs: NOW };

function seed() {
  listContacts.mockResolvedValue({
    total: 3,
    items: [
      { id: C, display_name: FULL, phone: PHONE, email: EMAIL, tags: ['vip', EMAIL], origin: 'manual', first_seen_at: '2026-10-01T00:00:00Z', last_activity_at: '2026-10-09T00:00:00Z', consent_recorded: true, sources_count: 2 },
      { id: 'c2', display_name: PHONE, phone: PHONE, email: null, tags: [], origin: 'manual', first_seen_at: '2026-10-01T00:00:00Z', last_activity_at: '2026-10-09T00:00:00Z', consent_recorded: false, sources_count: 0 },
      { id: 'c3', display_name: EMAIL, phone: null, email: EMAIL, tags: [], origin: 'manual', first_seen_at: '2026-10-01T00:00:00Z', last_activity_at: '2026-10-09T00:00:00Z', consent_recorded: false, sources_count: 0 },
    ],
  });
  getContactCard.mockResolvedValue({
    id: C, display_name: FULL, phone: PHONE, email: EMAIL, tags: [`звонить ${PHONE}`], notes: `Перезвонить: ${DIRTY}`,
    origin: 'operator_booking', has_account: false, consent: { recorded_at: '2026-10-01T00:00:00Z', source: 'booking', version: '1' },
    first_seen_at: '2026-10-01T00:00:00Z', last_activity_at: '2026-10-09T00:00:00Z',
    sources: [{ kind: 'operator_booking', id: '42', occurred_at: '2026-10-02T00:00:00Z', title: `Вулкан ${PHONE}`, date_from: `с 15-го, ${EMAIL}`, date_to: null, status: 'new', people: 2, person_name: FULL }],
    events: [{ id: 'e1', kind: 'call', actor_kind: 'partner_user', title: `Звонил ${PHONE}`, details: `Почта ${EMAIL}`, source_kind: null, source_id: null, occurred_at: '2026-10-03T00:00:00Z' }],
  });
  listTasks.mockResolvedValue([
    { id: T, title: `Позвонить ${PHONE}`, details: EMAIL, due_at: '2026-10-09T00:00:00Z', done_at: null, contact: { id: C, display_name: FULL }, created_at: '2026-10-01T00:00:00Z', reminder: null },
  ]);
  loadInbox.mockResolvedValue({
    category: 'operator',
    items: [{ kind: 'lead', id: 'l1', created_at: '2026-10-09T20:00:00Z', title: `Подбор ${PHONE}`, date: `июль, ${EMAIL}`, people: 3, contact_id: C, contact_name: FULL, waiting_minutes: 240 }],
    failed: ['seat_request'],
    response: { window_days: 7, median_minutes: null, responded: 2, enough: false, complete: false },
    chat: { state: 'ok', unread: 1 },
    not_here: [],
  });
  addContactTouch.mockResolvedValue({ outcome: 'recorded', id: 'e9' });
  createTask.mockResolvedValue({ outcome: 'created', task: { id: T, due_at: '2026-10-11T22:00:00.000Z' } });
  completeTask.mockResolvedValue({ outcome: 'done', task: { id: T } });
}

beforeEach(() => {
  for (const m of [listContacts, getContactCard, addContactTouch, createTask, completeTask, listTasks, loadInbox]) m.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  seed();
});

const READS: Array<[string, Record<string, unknown>]> = [
  ['crm_inbox', {}],
  ['crm_find_contact', { query: 'анна' }],
  ['crm_contact_card', { contact_id: C }],
  ['crm_tasks', {}],
];

describe('модели — подпись и contact_id, без телефонов, почт и фамилий', () => {
  it('подпись клиента: имя и буква фамилии; имя-телефон и имя-почта подписью не становятся', () => {
    expect(tools.contactLabel(FULL)).toBe('Анна П.');
    expect(tools.contactLabel(PHONE)).toBe('Клиент без имени');
    expect(tools.contactLabel(EMAIL)).toBe('Клиент без имени');
    expect(tools.contactLabel(null)).toBe('Клиент без имени');
  });

  for (const [name, args] of READS) {
    it(`${name}: в ответе нет телефона, почты и фамилии`, async () => {
      const r = await tools.executeCrmTool(name, args, CTX);
      expect(r.ok, name).toBe(true);
      const out = tools.crmToolText(r);
      expect(hasPII(out), `${name}: ${out}`).toBe(false);
      expect(out).not.toContain('Петрова');
      expect(out.replace(/\D/g, '')).not.toContain('9141112233');
    });
  }

  it('клиент в ответе — contact_id и подпись', async () => {
    const out = tools.crmToolText(await tools.executeCrmTool('crm_find_contact', { query: 'анна' }, CTX));
    expect(out).toContain(C);
    expect(out).toContain('Анна П.');
  });

  it('карточка не отдаёт имя человека из брони — второе имя модели не нужно', async () => {
    const r = await tools.executeCrmTool('crm_contact_card', { contact_id: C }, CTX);
    expect(JSON.stringify(r)).not.toMatch(/"(person_name|phone|email)":/);
  });

  it('фамилия клиента в его заметке гасится до буквы в любом падеже; цены и даты целы', () => {
    expect(tools.maskClientName('Перезвонить Петровой, бронь Петрова на 15-е, 45000 ₽', FULL))
      .toBe('Перезвонить П., бронь П. на 15-е, 45000 ₽');
    expect(tools.maskClientName('Ким просил Кимчи', 'Анна Ким')).toBe('К. просил Кимчи');
    expect(tools.maskClientName('цена 914 ₽', PHONE)).toBe('цена 914 ₽');
    expect(tools.maskClientName('Петровой', null)).toBe('Петровой');
  });

  it('входящие называют вид, который не прочитался, и что непрочитано в чате', async () => {
    const r = await tools.executeCrmTool('crm_inbox', {}, CTX);
    const data = (r as { ok: true; data: { not_read: string[]; platform_chat_unread: unknown } }).data;
    expect(data.not_read).toEqual(['Запрос мест']);
    expect(data.platform_chat_unread).toBe(1);
  });
});

describe('скоуп и право записи', () => {
  it('партнёр — из контекста, а не из аргументов модели', async () => {
    await tools.executeCrmTool('crm_find_contact', { query: 'x', partner_id: 'чужой' }, CTX);
    await tools.executeCrmTool('crm_contact_card', { contact_id: C, partner_id: 'чужой' }, CTX);
    await tools.executeCrmTool('crm_inbox', { partner_id: 'чужой' }, CTX);
    expect(listContacts.mock.calls[0][0]).toBe(P);
    expect(getContactCard.mock.calls[0][0]).toBe(P);
    expect(loadInbox.mock.calls[0].slice(0, 3)).toEqual([P, 'operator', U]);
  });

  it('без права записи пишущие инструменты отказывают словами и в базу не ходят', async () => {
    const ro = { ...CTX, canWrite: false };
    for (const [name, args] of [
      ['crm_add_touch', { contact_id: C, kind: 'call', title: 'Звонил' }],
      ['crm_add_task', { title: 'Перезвонить', due: '2026-10-12' }],
      ['crm_complete_task', { task_id: T }],
    ] as const) {
      const r = await tools.executeCrmTool(name, args, ro);
      expect(r, name).toEqual({ ok: false, error: expect.stringMatching(/только для чтения/) });
    }
    expect(addContactTouch).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
    expect(completeTask).not.toHaveBeenCalled();
    const visible = tools.crmToolDefinitions(false).map((d) => d.function.name);
    for (const w of tools.CRM_WRITE_TOOL_NAMES) expect(visible).not.toContain(w);
    expect(tools.CRM_WRITE_TOOL_NAMES).toEqual(['crm_add_touch', 'crm_add_task', 'crm_complete_task']);
  });

  it('запись подписана Кузьмичом: касание, задача и выполнение', async () => {
    await tools.executeCrmTool('crm_add_touch', { contact_id: C, kind: 'call', title: 'Звонил, договорились' }, CTX);
    expect(addContactTouch).toHaveBeenCalledWith(P, C, expect.objectContaining({ kind: 'call', actorKind: 'kuzmich', actorUserId: U }), expect.anything());

    await tools.executeCrmTool('crm_add_task', { title: 'Перезвонить', due: '2026-10-12', contact_id: C }, CTX);
    expect(createTask).toHaveBeenCalledWith(P, expect.objectContaining({ origin: 'kuzmich', createdBy: U, contactId: C }), expect.anything());

    await tools.executeCrmTool('crm_complete_task', { task_id: T }, CTX);
    expect(completeTask).toHaveBeenCalledWith(P, T, U, expect.anything(), 'kuzmich');
  });

  it('чужой клиент и чужая задача — «не найден», а не запись', async () => {
    addContactTouch.mockResolvedValueOnce({ outcome: 'not_found' });
    completeTask.mockResolvedValueOnce({ outcome: 'not_found' });
    expect((await tools.executeCrmTool('crm_add_touch', { contact_id: C, kind: 'note', title: 'x' }, CTX)).ok).toBe(false);
    expect((await tools.executeCrmTool('crm_complete_task', { task_id: T }, CTX)).ok).toBe(false);
  });

  it('битые аргументы и неизвестное имя — отказ словами до базы', async () => {
    expect((await tools.executeCrmTool('crm_contact_card', { contact_id: 'не-uuid' }, CTX)).ok).toBe(false);
    expect((await tools.executeCrmTool('crm_drop_all', {}, CTX)).ok).toBe(false);
    expect(getContactCard).not.toHaveBeenCalled();
  });
});

describe('отказ базы — названный отказ', () => {
  it('исключение функции CRM — ok:false со словами и SQLSTATE в логе', async () => {
    listContacts.mockRejectedValueOnce(Object.assign(new Error('x'), { code: '57014' }));
    const r = await tools.executeCrmTool('crm_find_contact', { query: 'a' }, CTX);
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/не прочитались.*не придумывай/) });
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toMatch(/crm_find_contact не выполнен, SQLSTATE 57014/);
  });
});

describe('срок задачи — камчатское время', () => {
  it('дата без времени — 10:00 по Камчатке', () => {
    const r = tools.parseDue('2026-10-12', NOW);
    expect(r).toEqual({ ok: true, at: new Date('2026-10-11T22:00:00.000Z') });
  });

  it('дата со временем — это время по Камчатке', () => {
    expect(tools.parseDue('2026-10-12T15:30', NOW)).toEqual({ ok: true, at: new Date('2026-10-12T03:30:00.000Z') });
  });

  it('несуществующая дата, чужой формат и прошлое — отказ', () => {
    expect(tools.parseDue('2026-02-30', NOW).ok).toBe(false);
    expect(tools.parseDue('завтра', NOW).ok).toBe(false);
    expect(tools.parseDue('2026-10-12T25:00', NOW).ok).toBe(false);
    expect(tools.parseDue('2025-10-12', NOW)).toEqual({ ok: false, error: expect.stringMatching(/уже прошёл/) });
  });

  it('прошедший срок до базы не доходит', async () => {
    const r = await tools.executeCrmTool('crm_add_task', { title: 'x', due: '2025-01-01' }, CTX);
    expect(r.ok).toBe(false);
    expect(createTask).not.toHaveBeenCalled();
  });
});

describe('один мозг: инструменты зовут функции кабинета', () => {
  const src = readFileSync('lib/crm/tools.ts', 'utf8');

  it('своего SQL у инструментов нет', () => {
    expect(src).not.toMatch(/\.query\s*[<(]/);
    expect(src).not.toMatch(/\bSELECT\b|\bINSERT\b|\bUPDATE\b/);
  });

  it('данные — из тех же модулей, что экран кабинета', () => {
    for (const m of ['@/lib/crm/contact-queries', '@/lib/crm/tasks', '@/lib/crm/events', '@/lib/crm/inbox']) {
      expect(src).toContain(`from '${m}'`);
    }
  });

  it('в публичный реестр Кузьмича (он же публичный MCP) инструменты CRM не попали', () => {
    const registry = readFileSync('lib/kuzmich/tool-schemas.ts', 'utf8') + readFileSync('lib/mcp/public-tools.ts', 'utf8');
    for (const n of tools.CRM_TOOL_NAMES) expect(registry, n).not.toContain(n);
  });
});
