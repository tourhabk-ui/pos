/**
 * Сторож ленты (CRM #2325, шаг 1б): дверь касаний и словарь видов.
 *
 * Касание пишет роут экрана тем же `addContactTouch`, что Кузьмич и MCP
 * партнёра; здесь держится форма двери: партнёр из гарда, а не из тела;
 * событие не бывает в будущем (для этого задачи); чужой клиент — 404. И
 * связка словаря: виды в коде = CHECK миграции, и у каждого вида есть
 * производитель (правило 10.09).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { ACTOR_KINDS, EVENT_KINDS, TOUCH_KINDS } from '@/lib/crm/event-kinds';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const requirePartner = vi.fn();
const addContactTouch = vi.fn();
vi.mock('@/lib/crm/partner-context', () => ({ requirePartner: (...a: unknown[]) => requirePartner(...a) }));
vi.mock('@/lib/crm/events', () => ({ addContactTouch: (...a: unknown[]) => addContactTouch(...a) }));

const route = await import('@/app/api/hub/crm/contacts/[id]/events/route');

const OK = { outcome: 'ok', partnerId: 'p-1', category: 'operator', userId: 'u-1' };
const UUID = '00000000-0000-4000-8000-000000000001';
const req = (body: unknown) => new NextRequest(`http://localhost/api/hub/crm/contacts/${UUID}/events`, {
  method: 'POST', body: JSON.stringify(body),
});
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  requirePartner.mockReset().mockResolvedValue(OK);
  addContactTouch.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('POST /api/hub/crm/contacts/[id]/events', () => {
  it('гард не пустил — его ответ, запись не тронута', async () => {
    requirePartner.mockResolvedValueOnce(NextResponse.json({ success: false }, { status: 403 }));
    expect((await route.POST(req({ kind: 'note', title: 'x' }), ctx(UUID))).status).toBe(403);
    expect(addContactTouch).not.toHaveBeenCalled();
  });

  it('партнёр и автор — из гарда, а не из тела', async () => {
    addContactTouch.mockResolvedValueOnce({ outcome: 'recorded', id: '7' });
    const r = await route.POST(req({ kind: 'call', title: ' Позвонил ', details: 'перенесли', partner_id: 'p-chuzhoi' }), ctx(UUID));
    expect(r.status).toBe(201);
    expect((await r.json()).data).toEqual({ id: '7' });
    expect(addContactTouch.mock.calls[0][0]).toBe('p-1');
    expect(addContactTouch.mock.calls[0][1]).toBe(UUID);
    expect(addContactTouch.mock.calls[0][2]).toMatchObject({ kind: 'call', title: 'Позвонил', details: 'перенесли', actorKind: 'partner_user', actorUserId: 'u-1' });
  });

  it('только заметка, звонок, встреча; смена статуса руками не пишется', async () => {
    expect((await route.POST(req({ kind: 'status_change', title: 'x' }), ctx(UUID))).status).toBe(400);
    expect((await route.POST(req({ kind: 'note', title: '   ' }), ctx(UUID))).status).toBe(400);
    expect(addContactTouch).not.toHaveBeenCalled();
  });

  it('событие в будущем — 400: для этого есть задачи; задним числом — можно', async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const r = await route.POST(req({ kind: 'meeting', title: 'Встреча', occurred_at: future }), ctx(UUID));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/будущем/);
    addContactTouch.mockResolvedValueOnce({ outcome: 'recorded', id: '8' });
    const past = new Date(Date.now() - 3_600_000).toISOString();
    expect((await route.POST(req({ kind: 'meeting', title: 'Встреча', occurred_at: past }), ctx(UUID))).status).toBe(201);
    expect(addContactTouch.mock.calls[0][2].occurredAt).toBeInstanceOf(Date);
  });

  it('не uuid — 404 без похода в базу; чужой клиент — 404; отказ базы — 503', async () => {
    expect((await route.POST(req({ kind: 'note', title: 'x' }), ctx('1; DROP'))).status).toBe(404);
    expect(addContactTouch).not.toHaveBeenCalled();
    addContactTouch.mockResolvedValueOnce({ outcome: 'not_found' });
    expect((await route.POST(req({ kind: 'note', title: 'x' }), ctx(UUID))).status).toBe(404);
    addContactTouch.mockRejectedValueOnce(Object.assign(new Error('x'), { code: '57014' }));
    expect((await route.POST(req({ kind: 'note', title: 'x' }), ctx(UUID))).status).toBe(503);
  });
});

describe('словарь ленты — один в коде и в схеме', () => {
  // Действует последняя миграция, задавшая ограничение: 1196 завела словарь,
  // следующие (1197 — task_done) его пересоздают. Номер — числом, не текстом.
  const migrations = readdirSync(join(ROOT, 'migrations'))
    .filter((n) => /^\d+_.*\.sql$/.test(n))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  const listOf = (constraint: string): string[] => {
    const re = new RegExp(`CONSTRAINT ${constraint} CHECK \\([a-z_]+ IN \\(([^)]*)\\)`);
    const last = migrations.map((n) => re.exec(read(`migrations/${n}`))).filter((m): m is RegExpExecArray => m !== null).pop();
    if (!last) throw new Error(`${constraint} не найден в миграциях`);
    return [...last[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
  };

  it('CHECK вида события совпадает с EVENT_KINDS, касания — подмножество', () => {
    expect(listOf('crm_events_kind_check')).toEqual([...EVENT_KINDS].sort());
    for (const t of TOUCH_KINDS) expect(EVENT_KINDS as readonly string[]).toContain(t);
  });

  const walk = (dir: string): string[] => readdirSync(join(ROOT, dir)).flatMap((n) => {
    if (n === 'node_modules' || n.startsWith('.')) return [];
    const rel = `${dir}/${n}`;
    return statSync(join(ROOT, rel)).isDirectory() ? walk(rel) : /\.(ts|tsx)$/.test(n) && !/\.test\./.test(n) ? [rel] : [];
  });
  // Производитель — файл, зовущий писателя ленты; сам модуль писателя и
  // словарь не считаются: литерал вида в них — объявление, не производство.
  const producers = [...walk('app'), ...walk('lib')]
    .filter((f) => f !== 'lib/crm/events.ts' && f !== 'lib/crm/event-kinds.ts')
    .map(read)
    .filter((s) => /from '@\/lib\/crm\/(events|chat-events)'/.test(s));

  it('у каждого вида события есть производитель в коде (правило 10.09)', () => {
    expect(producers.length, 'производителей ленты не найдено — сломан поиск').toBeGreaterThan(5);
    const src = producers.join('\n');
    const produced = new Set<string>();
    // Вид передаётся литералом или выбором из литералов (`outgoing ? 'a' : 'b'`).
    for (const m of src.matchAll(/\bkind: ([^\n]+)/g)) {
      for (const k of m[1].matchAll(/'([a-z_]+)'/g)) produced.add(k[1]);
    }
    // Касания — любой из TOUCH_KINDS приходит из формы; производитель — дверь,
    // которая и схему строит из TOUCH_KINDS, и зовёт addContactTouch.
    if (producers.some((s) => /TOUCH_KINDS/.test(s) && /addContactTouch\(/.test(s))) {
      for (const t of TOUCH_KINDS) produced.add(t);
    }
    const orphans = EVENT_KINDS.filter((k) => !produced.has(k));
    expect(orphans, 'вид события без производителя — провод в никуда').toEqual([]);
  });

  /**
   * Актёр без производителя — тот же провод в никуда. Два актёра объявлены
   * заранее под шаг 1д (Кузьмич партнёра и MCP партнёра зовут те же
   * функции писателя); запись самоустаревает: появился производитель —
   * тест требует её убрать.
   */
  const KNOWN_UNPRODUCED_ACTORS: Readonly<Record<string, string>> = {
    kuzmich: 'шаг 1д: Кузьмич партнёра пишет касания через addContactTouch',
    mcp: 'шаг 1д: MCP партнёра пишет касания через addContactTouch',
  };

  it('CHECK актёра совпадает с ACTOR_KINDS', () => {
    expect(listOf('crm_events_actor_check')).toEqual([...ACTOR_KINDS].sort());
  });

  it('у каждого актёра есть производитель или причина в KNOWN_UNPRODUCED_ACTORS (самоустаревает)', () => {
    const src = producers.join('\n');
    const produced = new Set<string>();
    for (const m of src.matchAll(/\bactorKind: ([^\n]+)/g)) {
      for (const k of m[1].matchAll(/'([a-z_]+)'/g)) produced.add(k[1]);
    }
    const orphans = ACTOR_KINDS.filter((a) => !produced.has(a) && !(a in KNOWN_UNPRODUCED_ACTORS));
    expect(orphans, 'актёр без производителя — провод в никуда').toEqual([]);
    for (const [a, why] of Object.entries(KNOWN_UNPRODUCED_ACTORS)) {
      expect(ACTOR_KINDS as readonly string[], `${a}: актёра больше нет — убрать запись`).toContain(a);
      expect(produced.has(a), `${a}: производитель появился — убрать запись (${why})`).toBe(false);
      expect(why.length).toBeGreaterThan(10);
    }
  });
});
