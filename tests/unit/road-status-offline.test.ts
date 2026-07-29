/**
 * Статус дорог в офлайне и пуше (issue #836).
 *
 * Данные road_closure ingest'ились с 27.07 и жили в external_alerts →
 * location_real_time_status, но до туриста доходили только онлайн, на
 * карточке маршрута. Два разрыва:
 *   1) офлайн-пакет нёс описание и трек, но НЕ ограничения — скачавший
 *      регион перед выездом о перекрытии не знал;
 *   2) пуш слался при severity>=2, а road_closure приходит с 1 — узнать
 *      можно было, только упершись в шлагбаум.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const BY_REGION = read('app/api/routes/by-region/route.ts');
const DB = read('lib/offline/db.ts');
const REGION_HOOK = read('lib/offline/useOfflineRegion.ts');
const MAP = read('app/map/_MapPageClient.tsx');
const LEAFLET = read('components/shared/LeafletMap.tsx');
const CRON = read('app/api/cron/safety-ingest/route.ts');

describe('офлайн-пакет несёт ограничения', () => {
  it('by-region отдаёт активные алерты и время съёма', () => {
    expect(BY_REGION).toContain('lrs.active_alerts');
    expect(BY_REGION).toContain('lrs.alert_severity');
    expect(BY_REGION).toContain('LEFT JOIN location_real_time_status');
    expect(BY_REGION).toContain('activeAlerts:');
    expect(BY_REGION).toContain('alertsAt:');
  });

  it('колонки квалифицированы: LEFT JOIN не даёт ambiguous (урок аудита Stay)', () => {
    // Неквалифицированные id/updated_at есть в обеих таблицах → 500.
    expect(BY_REGION).toContain('ark.id,');
    expect(BY_REGION).toContain('ark.is_visible = TRUE');
    expect(BY_REGION).toContain('ORDER BY ark.title');
    expect(BY_REGION).not.toMatch(/\n\s+WHERE\n\s+is_visible/);
  });

  it('IndexedDB: поля в схеме, версия поднята (апгрейд без потери данных)', () => {
    expect(DB).toContain('activeAlerts: string[]');
    expect(DB).toContain('alertSeverity: number');
    expect(DB).toContain('alertsAt: number | null');
    expect(DB).toContain('const DB_VERSION = 2');
  });

  it('скачивание кладёт ограничения с дефолтами (старый билд API не ломает пакет)', () => {
    expect(REGION_HOOK).toContain('activeAlerts: r.activeAlerts ?? []');
    expect(REGION_HOOK).toContain('alertSeverity: r.alertSeverity ?? 0');
    expect(REGION_HOOK).toContain('alertsAt: r.alertsAt ?? null');
  });
});

describe('карта показывает ограничения', () => {
  it('офлайн-точки получают restrictions из пакета', () => {
    expect(MAP).toContain('restrictions:   r.activeAlerts ?? []');
    expect(MAP).toContain('restrictionsAt: r.alertsAt ?? null');
  });

  it('маркеры пробрасывают ограничения в попап', () => {
    expect(MAP).toContain('restrictions:   r.restrictions ?? undefined');
  });

  it('попап рисует блок ограничений ПЕРЕД описанием и экранирует текст', () => {
    const popup = LEAFLET.slice(LEAFLET.indexOf('function buildPopupHtml'), LEAFLET.indexOf('export default function LeafletMap'));
    expect(popup).toContain('Ограничения');
    // Блок ограничений идёт раньше описания — в поле это важнее.
    expect(popup.indexOf('marker.restrictions')).toBeLessThan(popup.indexOf('marker.description'));
    // Текст алертов приходит из БД — только через escapeHtml.
    expect(popup).toContain('marker.restrictions.map(escapeHtml)');
    expect(popup).toContain('escapeHtml(marker.title)');
    expect(popup).toContain('escapeHtml(marker.description)');
    expect(LEAFLET).toContain('function escapeHtml');
  });

  it('возраст данных показывается — устаревшее не выдаётся за свежее', () => {
    expect(LEAFLET).toContain('function ageLabel');
    expect(LEAFLET).toContain('данные ${ageLabel');
  });
});

describe('пуш при закрытии дороги', () => {
  it('road_closure проходит порог severity наравне с цунами', () => {
    expect(CRON).toContain("alert_type IN ('tsunami_warning', 'road_closure')");
  });

  it('у пуша свой заголовок и совет «до выезда», а не чужой про землетрясение', () => {
    expect(CRON).toContain("alert.alert_type === 'road_closure'");
    expect(CRON).toContain('Ограничение проезда — Камчатка');
    expect(CRON).toContain('Проверьте подъезд до выезда');
  });
});
