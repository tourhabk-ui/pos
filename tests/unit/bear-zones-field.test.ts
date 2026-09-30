/**
 * Медвежьи зоны — с экрана маршрута и на экране маршрута (#2095).
 *
 * С 19.09 (#1957) зоны строились из подтверждённых наблюдений `bear` и
 * предупреждали на /map. Разрывов было три, и каждый делал механизм
 * объявленным, а не работающим (§4, правило 10.09):
 *  1. полевая форма наблюдения писала `animal` — зоны берут только `bear`,
 *     и медведь с тропы доходил до модератора, но не до идущих следом;
 *  2. предупреждение о близости жило только на /map — на экране «На
 *     маршруте», где человек и идёт, его не было;
 *  3. зоны попадали в телефон, только если карту открыли онлайн — сборка
 *     полевого пакета их не обновляла.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(p, 'utf-8');

describe('производитель: форма с тропы пишет тот род, из которого строится зона', () => {
  const form = read('components/field/ObservationSheet.tsx');
  const zonesRoute = read('app/api/safety/geofence-zones/route.ts');

  it('у формы есть «Медведь» со значением bear', () => {
    expect(form).toMatch(/\{ value: 'bear', label: 'Медведь'/);
  });

  it('потребитель берёт ровно это значение', () => {
    expect(zonesRoute).toMatch(/WHERE report_type = 'bear'/);
  });

  it('приёмник и схема принимают bear', () => {
    expect(read('app/api/safety/reports/route.ts')).toMatch(/'bear'/);
    expect(read('migrations/917_trail_observations_from_route_screen.sql')).toMatch(/'bear'/);
  });

  it('по умолчанию — не медведь: ложная зона хуже пропущенной отметки', () => {
    expect(form).toMatch(/useState<string>\('animal'\)/);
  });
});

describe('модерация: зона появляется после одобрения — одобрение должно выполняться', () => {
  const route = read('app/api/safety/reports/route.ts');

  it('подсказка одобрения — по id записи, без ORDER BY в UPDATE', () => {
    // «UPDATE ... ORDER BY created_at DESC» PostgreSQL отвергает синтаксисом
    // (проверено на PG 16), а по смыслу одобрял все ожидающие разом.
    expect(route).not.toMatch(/UPDATE trail_reports[^`]*ORDER BY/);
    expect(route).toMatch(/UPDATE trail_reports SET status='approved' WHERE id='\$\{escapeHtml\(id\)\}' AND status='pending'/);
    expect(route).toMatch(/notifyOwnerAsync\(result\.rows\[0\]\.id,/);
  });

  it('текст туриста в HTML-сообщение — только экранированным', () => {
    expect(route).toMatch(/\$\{escapeHtml\(text\)\}\$\{coords\}/);
  });
});

describe('экран «На маршруте» предупреждает о зонах', () => {
  const screen = read('app/planning/_PlanningClient.tsx');
  const trail = screen.slice(screen.indexOf('function OnTrailTab('), screen.indexOf('function PlanningTab('));

  it('зоны и суд близости — по фиксу экрана, без второго наблюдателя GPS', () => {
    expect(trail).toMatch(/useGeofenceZones\(\)/);
    expect(trail).toMatch(/useGeofenceBreach\(\s*coords \?/);
    expect(trail).not.toMatch(/useOfflineGPS\(/);
  });

  it('предупреждение не у нижнего края — там SOS и полевые действия', () => {
    expect(trail).toMatch(/<GeofenceAlert breach=\{geoBreach\}[^>]*topOffset=\{/);
  });

  it('/map остался на прежнем хуке', () => {
    expect(read('app/map/_MapPageClient.tsx')).toMatch(/useGeofence\(\)/);
  });

  it('сборка полевого пакета обновляет кеш зон', () => {
    const assemble = screen.slice(screen.indexOf('const assemblePack = useCallback'), screen.indexOf('const refreshPackStates'));
    expect(assemble).toMatch(/await refreshGeofenceZones\(\)/);
    expect(assemble).toMatch(/console\.warn\('\[field-pack\] зоны опасности не обновлены/);
  });
});

describe('refreshGeofenceZones: исход назван, пустое не затирает старое', () => {
  const KEY = 'vedar_geofence_zones';
  const zone = { id: 'bear_1', name: 'Наблюдение медведя', lat: 53, lng: 158, radiusM: 2000, hazard: 'wildlife', level: 'warning', message: 'm' };

  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('зоны пришли — кеш обновлён', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ success: true, zones: [zone] }) })));
    const { refreshGeofenceZones } = await import('@/hooks/useGeofence');
    expect(await refreshGeofenceZones()).toBe('ok');
    expect(JSON.parse(localStorage.getItem(KEY)!).zones).toHaveLength(1);
  });

  it('сервер без зон — кеш прежний', async () => {
    localStorage.setItem(KEY, JSON.stringify({ zones: [zone], ts: 1 }));
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ success: true, zones: [] }) })));
    const { refreshGeofenceZones } = await import('@/hooks/useGeofence');
    expect(await refreshGeofenceZones()).toBe('empty');
    expect(JSON.parse(localStorage.getItem(KEY)!).ts).toBe(1);
  });

  it('сеть не дошла — failed, не «ok»', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const { refreshGeofenceZones } = await import('@/hooks/useGeofence');
    expect(await refreshGeofenceZones()).toBe('failed');
  });
});
