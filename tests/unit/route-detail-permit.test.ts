/**
 * Загрузчик карточки маршрута отдаёт случай территории (#3302, срез 6).
 *
 * Блок о разрешении парка на карточке решает, что утверждать, по полю
 * `permit`. Считает его сервер тем же правилом, что ответ Кузьмича и MCP
 * (lib/parks/route-permit), и отдаёт и странице, и `/api/routes/[id]` — сборка
 * у них одна (loadRouteDetail). Сторож — вызовом загрузчика на подменённой базе.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const queryMock = vi.hoisted(() => vi.fn());
const poolQuery = vi.hoisted(() => vi.fn());
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => queryMock(...a) }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => poolQuery(...a) } }));

import { loadRouteDetail } from '@/lib/routes/route-detail';
import { ROUTE_PARK_SQL } from '@/lib/parks/route-permit';
import { PARK_PERMIT_SOURCE } from '@/lib/safety/park-permit';

const ROUTE_ROW = {
  id: 'r-1', route_dedupe_key: 'r', route_id: null, category: 'route', location_type: null,
  activity_type: 'trekking', title: 'Тропа', description: 'Подъём', lat: '52.5', lng: '158.0',
  source_url: null, source_name: null, payload: {}, created_at: '2026-01-01', kuzmich_review: null,
  has_real_image: false, kr_id: 'r-1', kr_ark_id: null,
  mchs_registration_required: false, park_name: null as string | null, park_approval_url: null,
};
const parkRow = (slug: string, display_name: string, over: Record<string, string | null> = {}) => ({
  slug, display_name, permit_url: null, permit_email: null, permit_office_address: null,
  permit_office_hours: null, permit_gosuslugi_url: null, permit_online_url: null, ...over,
});

function db(route: Partial<typeof ROUTE_ROW>, parks: unknown[] | Error = []) {
  queryMock.mockImplementation((sql: string) => Promise.resolve({
    rows: sql.includes('FROM agent_route_knowledge') ? [{ ...ROUTE_ROW, ...route }] : [],
  }));
  poolQuery.mockImplementation((sql: string) => {
    if (sql === ROUTE_PARK_SQL) return parks instanceof Error ? Promise.reject(parks) : Promise.resolve({ rows: parks });
    return Promise.resolve({ rows: [] });
  });
}
const parkCalls = () => poolQuery.mock.calls.filter(([sql]) => sql === ROUTE_PARK_SQL);

async function permitOf(): Promise<unknown> {
  const r = await loadRouteDetail('r-1', { explain: false, countView: false });
  expect(r.kind).toBe('found');
  if (r.kind !== 'found') throw new Error('карточка не собралась');
  // Страница отдаёт карточку клиенту через JSON — случай обязан пережить его.
  const data = JSON.parse(JSON.stringify(r.data)) as { permit: unknown };
  expect(data.permit).toEqual(r.data.permit);
  return data.permit;
}

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => { errors = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); queryMock.mockReset(); poolQuery.mockReset(); });

describe('случай территории в данных карточки', () => {
  it('справочник ведёт территорию на страницу условий КГБУ — «kgbu»; спрошен по park_name маршрута', async () => {
    db({ park_name: 'Природный парк «Вилючинский»' },
      [parkRow('vilyuchinsky', 'Природный парк «Вилючинский»', { permit_url: PARK_PERMIT_SOURCE.url })]);
    expect(await permitOf()).toEqual({ kind: 'kgbu' });
    expect(parkCalls()).toHaveLength(1);
    expect(parkCalls()[0]![1]).toEqual(['Природный парк «Вилючинский»']);
  });

  it('территория не записана — «none», справочник не спрашивается (регистрация в МЧС парка не называет)', async () => {
    db({ park_name: null, mchs_registration_required: true });
    expect(await permitOf()).toEqual({ kind: 'none' });
    expect(parkCalls()).toHaveLength(0);
  });

  it('территория названа, в справочнике её нет — «unrecorded» с названием', async () => {
    db({ park_name: 'памятник природы «Сопка Никольская»' }, []);
    expect(await permitOf()).toEqual({ kind: 'unrecorded', territory: 'памятник природы «Сопка Никольская»' });
  });

  it('у территории своя запись — «recorded» с её каналами', async () => {
    db({ park_name: 'Командорские острова' },
      [parkRow('komandorskiy', 'Национальный парк «Командорские острова»', { permit_email: 'ohrana@example.org' })]);
    expect(await permitOf()).toEqual({
      kind: 'recorded',
      park: {
        slug: 'komandorskiy', displayName: 'Национальный парк «Командорские острова»', permitUrl: null,
        email: 'ohrana@example.org', officeAddress: null, officeHours: null, gosuslugiUrl: null, onlineUrl: null,
      },
    });
  });

  it('несколько записей на одно название — «ambiguous» с их именами', async () => {
    db({ park_name: 'Парк' }, [parkRow('a', 'Парк А'), parkRow('b', 'Парк Б')]);
    expect(await permitOf()).toEqual({ kind: 'ambiguous', territory: 'Парк', names: ['Парк А', 'Парк Б'] });
  });

  it('справочник не прочитался — «unread»: карточка собирается, отказ в логе, «условий нет» не говорится', async () => {
    db({ park_name: 'Природный парк «Налычево»' }, Object.assign(new Error('boom'), { code: '57014' }));
    expect(await permitOf()).toEqual({ kind: 'unread', territory: 'Природный парк «Налычево»' });
    expect(errors).toHaveBeenCalled();
    expect(String(errors.mock.calls[0]?.join(' '))).toContain('sqlstate=57014');
  });

  it('правило по названию справочника не ждёт: заказник, свободная зона, Вачкажец, федеральный парк', async () => {
    db({ park_name: 'государственный природный заказник федерального значения «Южно-Камчатский»' });
    expect(await permitOf()).toEqual({ kind: 'kronoki' });
    db({ title: 'Авачинский перевал', park_name: 'Природный парк «Налычево»' });
    expect(await permitOf()).toEqual({ kind: 'free_visit' });
    db({ title: 'Горный массив Вачкажец', park_name: null });
    expect(await permitOf()).toEqual({ kind: 'no_permit' });
    db({ title: 'Вулкан Горелый', park_name: 'Южно-Камчатский' });
    expect(await permitOf()).toEqual({ kind: 'federal' });
    expect(parkCalls()).toHaveLength(0);
  });
});
