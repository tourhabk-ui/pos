/**
 * «План, который бронирует» (карт-бланш владельца 08.08).
 *
 * Разведка по TAAFT (84 планировщика + 24 GPT в категории Travel Itineraries)
 * показала общую дыру рынка: все планируют, никто не бронирует. У нас есть
 * недостающее звено — реальные туры и оплата, но план вёл мимо него:
 *   · тур-подсказка в дне планера ссылалась на страницу ОПЕРАТОРА,
 *     хотя id тура был в руках;
 *   · публичная страница плана (/trip/[token]) показывала цены «от-до»
 *     без единой ссылки на тур, без карты и без safety-статуса.
 *
 * Сторож держит: обе поверхности плана ведут на карточку тура с бронью,
 * share-API прикладывает туры к дням, публичный план несёт карту и
 * fail-soft статус дня из safety-слоя.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const PLANNER = readFileSync(join(ROOT, 'app/planner/_PlannerClient.tsx'), 'utf-8');
const SHARE_API = readFileSync(join(ROOT, 'app/api/trips/share/[token]/route.ts'), 'utf-8');
const SHARE_UI = readFileSync(join(ROOT, 'app/trip/[token]/_TripShareClient.tsx'), 'utf-8');

describe('план ведёт к брони', () => {
  it('тур дня в планере — ссылка на карточку тура, не на страницу оператора', () => {
    expect(PLANNER).toMatch(/href=\{`\/catalog\/tours\/\$\{topTour\.id\}`\}/);
    expect(PLANNER).not.toMatch(/href=\{`\/operators\/\$\{topTour\.operator_slug\}`\}/);
  });

  it('share-API прикладывает реальный тур к каждой активности плана', () => {
    expect(SHARE_API).toMatch(/top_tours: topTours/);
    expect(SHARE_API).toMatch(/FROM operator_tours ot/);
    expect(SHARE_API).toMatch(/ot\.is_active = true AND ot\.is_published = true AND ot\.deleted_at IS NULL/);
  });

  it('подбор туров не роняет отдачу плана (fail-soft)', () => {
    expect(SHARE_API).toMatch(/catch \{ \/\* тур-подсказка необязательна \*\/ \}/);
  });

  it('публичный план рендерит бронь дня', () => {
    expect(SHARE_UI).toMatch(/\/catalog\/tours\/\$\{tour\.id\}/);
    expect(SHARE_UI).toMatch(/забронировать/);
  });
});

describe('публичный план: карта и статус дня', () => {
  it('карта с нумерованными точками дней (динамический Leaflet)', () => {
    expect(SHARE_UI).toMatch(/dynamic\(\(\) => import\('@\/components\/shared\/LeafletMap'\), \{ ssr: false \}\)/);
    expect(SHARE_UI).toMatch(/mapMarkers/);
  });

  it('safety-статус дня — fail-soft: нет данных — нет блока', () => {
    expect(SHARE_UI).toMatch(/\/api\/public\/safety-status/);
    expect(SHARE_UI).toMatch(/нет данных — нет блока/);
  });

  it('никакого legacy-view в новом SQL (§4.1)', () => {
    expect(SHARE_API).not.toMatch(/agent_route_knowledge/);
  });
});
