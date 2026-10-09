/**
 * edit_trip_plan и черновики плана (#2224).
 *
 * Сторож держит инструмент снаружи: правка несуществующего или истёкшего
 * плана — отказ, а не новый план с нуля; отказ базы — «повтори», а не «плана
 * нет» (§4.0); две правки одной ревизии — вторая не затирает первую молча;
 * успешная правка показывает план и тот же ID с номером правки. И черновик:
 * текст пожеланий уходит в базу только после redactPII (решение владельца
 * 08.10: «структуру и текст пожеланий»).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DayPlan } from '@/lib/planner/engine';

const queries: Array<{ sql: string; params: unknown[] }> = [];
let poolReply: (sql: string) => { rows: unknown[] } = () => ({ rows: [] });
vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      return poolReply(sql);
    }),
  },
}));

import { saveDraft, loadDraft, updateDraft } from '@/lib/planner/plan-drafts';
import { editTripPlanForKuzmich, readPlanEdit, planIdLine } from '@/lib/kuzmich/trip-plan-tool';

const ID = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
const day = (n: number, type: DayPlan['type'], title: string): DayPlan => ({
  day: n, type, zone: 'avachinsky', title, description: '', activityType: type === 'activity' ? 'volcano' : 'hot_spring',
  priceFrom: 0, priceTo: 0, coords: [53, 158], defaultTransport: 'walking', allowedTransports: ['walking'],
  difficulty: 'easy', childFriendly: true, minChildAge: 0, dayWarnings: [],
});
const DAYS: DayPlan[] = [
  day(1, 'arrival', 'Прилёт'), day(2, 'activity', 'Авачинский'), day(3, 'activity', 'Медведи'),
  day(4, 'rest', 'Отдых'), day(5, 'departure', 'Отъезд'),
];
const PARAMS = {
  interests: ['volcano', 'bears'], arrivalDate: '2027-07-10', departureDate: '2027-07-14',
  adults: 2, children: [], budgetTier: 'comfort',
};

beforeEach(() => {
  queries.length = 0;
  poolReply = () => ({ rows: [] });
});

describe('черновик: ПД и три исхода', () => {
  it('текст пожеланий пишется только после redactPII', async () => {
    poolReply = (sql) => (sql.startsWith('INSERT') ? { rows: [{ id: ID }] } : { rows: [] });
    const id = await saveDraft({ params: PARAMS as never, days: DAYS }, 'mcp', 'рыбалка, звоните +7 914 123-45-67, ivan@mail.ru');
    expect(id).toBe(ID);
    const insert = queries.find((q) => q.sql.startsWith('INSERT'));
    const wishes = String(insert?.params[2]);
    expect(wishes).not.toMatch(/914|ivan@mail/);
    expect(wishes).toContain('рыбалка');
    // Истёкшие удаляет сам писатель.
    expect(queries[0].sql).toMatch(/DELETE FROM trip_plan_drafts WHERE expires_at < NOW\(\)/);
  });

  it('чтение: нет, есть, не смог — три разных исхода', async () => {
    expect(await loadDraft('не-uuid')).toEqual({ kind: 'missing' });
    expect(queries).toHaveLength(0);
    expect(await loadDraft(ID)).toEqual({ kind: 'missing' });
    poolReply = () => { throw Object.assign(new Error('down'), { code: '57P01' }); };
    expect(await loadDraft(ID)).toEqual({ kind: 'failed' });
  });

  it('запись правки сверяет ревизию: устаревшая — conflict, не молчаливая перезапись', async () => {
    const r = await updateDraft({ id: ID, revision: 3, params: PARAMS as never, days: DAYS }, { params: PARAMS as never, days: DAYS });
    expect(r).toEqual({ kind: 'conflict' });
    expect(queries[0].sql).toMatch(/WHERE id = \$1::uuid AND revision = \$4 AND expires_at > NOW\(\)/);
    expect(queries[0].params[3]).toBe(3);
  });
});

describe('разбор правки', () => {
  it('структура, а не свободный текст; чего не хватает — словами', () => {
    expect(readPlanEdit({ action: 'remove_day', day: '3' })).toEqual({ ok: true, edit: { kind: 'remove_day', day: 3 } });
    expect(readPlanEdit({ action: 'move_day', day: '4', to_day: '2' })).toEqual({ ok: true, edit: { kind: 'move_day', day: 4, to: 2 } });
    expect(readPlanEdit({ action: 'add_day', interest: 'рыбалка' })).toEqual({ ok: true, edit: { kind: 'add_day', interest: 'fishing' } });
    expect(readPlanEdit({ action: 'set_lodging', lodging: 'на базу' })).toEqual({ ok: true, edit: { kind: 'set_lodging', tier: 'economy' } });
    expect(readPlanEdit({ action: 'remove_day' })).toMatchObject({ ok: false, error: expect.stringMatching(/номер дня/) });
    expect(readPlanEdit({ action: 'fly' })).toMatchObject({ ok: false });
    expect(readPlanEdit({ action: 'add_day', interest: 'что-нибудь' })).toMatchObject({ ok: false, error: expect.stringMatching(/не разобрал/) });
  });
});

describe('edit_trip_plan снаружи', () => {
  it('несуществующий или истёкший план — отказ, нового плана с нуля нет', async () => {
    const text = await editTripPlanForKuzmich({ plan_id: ID, action: 'remove_day', day: '3' });
    expect(text).toMatch(/не найден/);
    expect(text).toMatch(/новый план с нуля здесь не строю/);
    expect(text).not.toMatch(/День 1\./);
  });

  it('не ID вовсе — просит ID и не идёт в базу', async () => {
    expect(await editTripPlanForKuzmich({ plan_id: 'мой план', action: 'remove_day', day: '3' })).toMatch(/Нужен ID плана/);
    expect(queries).toHaveLength(0);
  });

  it('база не ответила — «повтори», а не «плана нет»', async () => {
    poolReply = () => { throw Object.assign(new Error('down'), { code: '57P01' }); };
    const text = await editTripPlanForKuzmich({ plan_id: ID, action: 'remove_day', day: '3' });
    expect(text).toMatch(/не прочитался/);
    expect(text).not.toMatch(/не найден/);
  });

  it('успешная правка: заметка, план без убранного дня, тот же ID с номером правки', async () => {
    poolReply = (sql) => {
      if (sql.includes('FROM trip_plan_drafts')) return { rows: [{ id: ID, params: PARAMS, days: DAYS, revision: 1 }] };
      if (sql.startsWith('UPDATE')) return { rows: [{ revision: 2 }] };
      return { rows: [] };
    };
    const text = await editTripPlanForKuzmich({ plan_id: ID, action: 'remove_day', day: '3' });
    expect(text).toMatch(/^Убрал день 3\./);
    expect(text).not.toMatch(/Медведи/);
    expect(text).toMatch(/День 3\. Отдых/);
    expect(text).toContain(`ID плана: ${ID} (правка 1)`);
    expect(text).toMatch(/Ориентир на человека/);
    // Итог на группу пересчитан по плану после правки (#2304).
    expect(text).toMatch(new RegExp(`Итого на группу из ${PARAMS.adults + PARAMS.children.length} чел\\.`));
  });

  it('невозможная правка — отказ с причиной, план прежний и ID тот же', async () => {
    poolReply = (sql) => (sql.includes('FROM trip_plan_drafts') ? { rows: [{ id: ID, params: PARAMS, days: DAYS, revision: 1 }] } : { rows: [] });
    const text = await editTripPlanForKuzmich({ plan_id: ID, action: 'remove_day', day: '1' });
    expect(text).toMatch(/^Правку не сделал: День 1 — день прилёта/);
    expect(text).toContain(`ID плана: ${ID}.`);
    expect(queries.some((q) => q.sql.startsWith('UPDATE'))).toBe(false);
  });

  it('чужая правка успела раньше — эту не записываем', async () => {
    poolReply = (sql) => (sql.includes('FROM trip_plan_drafts') ? { rows: [{ id: ID, params: PARAMS, days: DAYS, revision: 1 }] } : { rows: [] });
    expect(await editTripPlanForKuzmich({ plan_id: ID, action: 'remove_day', day: '3' })).toMatch(/успели изменить другим вызовом/);
  });
});

describe('make_trip_plan отдаёт ID', () => {
  it('сохраняет черновик только у собранного плана и с поверхностью вызова', async () => {
    const { readFileSync } = await import('node:fs');
    const tool = readFileSync('lib/kuzmich/trip-plan-tool.ts', 'utf-8');
    const core = readFileSync('lib/kuzmich/core.ts', 'utf-8');
    expect(tool).toMatch(/if \(rec\.days\.length > 0\) \{[\s\S]*?saveDraft\(\{ params, days: rec\.days \}, opts\.surface \?\? 'chat', args\.interests\)/);
    expect(core).toMatch(/\}, \{ surface: opts\.surface \?\? 'chat' \}\);/);
    expect(core).toMatch(/if \(name === 'edit_trip_plan'\)/);
  });
});

describe('строка ID', () => {
  it('черновик не записался — так и сказано', () => {
    expect(planIdLine(null, 1)).toMatch(/не сохранился/);
    expect(planIdLine(ID, 1)).toMatch(/^ID плана: 1b9d6bcd-.*edit_trip_plan/);
  });
});
