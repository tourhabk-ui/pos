/**
 * Полевой паспорт маршрута: граница доверия к данным видна ДО выбора.
 *
 * План Field Confidence Navigator, этап 1. Три инварианта:
 *
 * 1. Род данных (Трек / Набросок / Линия не проверена / Точки / Нет данных)
 *    выводится одним правилом поверх line-standard — источник важнее
 *    плотности, неизвестность не притворяется знанием.
 * 2. CTA обещает только то, что есть: «Открыть навигатор» — исключительно
 *    снятому треку; всему остальному — «Открыть ориентирование».
 * 3. Пространство id выбора маршрута едино: списки, поиск и детальный
 *    эндпоинт живут в id VIEW (COALESCE(ark_id, id)), внутренние таблицы
 *    (route_waypoints, operator_tours) ищутся через строку kamchatka_routes
 *    по обоим id. Маршрут с заполненным ark_id раньше молча терял трек,
 *    точки и находимость в поиске.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildRoutePassport, lineGradeForList,
  passportGradeLabel, passportGradeNote, passportCtaLabel,
} from '@/lib/routes/passport';
import { gradeFromSource } from '@/lib/map/line-standard';
import type { LatLng } from '@/lib/routes/track-fidelity';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

/** Снятый трек: густо, десятки точек на километр. */
const SURVEYED: LatLng[] = Array.from({ length: 400 }, (_, i) => [53 + i * 0.0002, 158] as LatLng);

const BASE = {
  waypointsCount: 5,
  routeVersion: 3,
  verifiedAt: null,
  updatedAt: null,
  mchsRequired: false,
  mchsPhone: null,
  parkName: null,
  parkApprovalUrl: null,
  officialPassportUrl: null,
};

describe('род данных — одно правило, источник важнее плотности', () => {
  it('густая синтетика — набросок, а не трек («Вулкан Жупановский»)', () => {
    const p = buildRoutePassport({ ...BASE, track: SURVEYED, geometrySource: 'waypoints_synthetic' });
    expect(p.grade).toBe('sketch');
  });

  it('снятый источник — трек', () => {
    const p = buildRoutePassport({ ...BASE, track: SURVEYED, geometrySource: 'idilesom' });
    expect(p.grade).toBe('surveyed');
  });

  it('линии нет, точки есть — points_only; нет ничего — none', () => {
    expect(buildRoutePassport({ ...BASE, track: null, geometrySource: null }).grade).toBe('points_only');
    expect(buildRoutePassport({ ...BASE, track: null, geometrySource: null, waypointsCount: 0 }).grade).toBe('none');
  });

  it('версия без миграции читается как первая редакция, не нулевая', () => {
    expect(buildRoutePassport({ ...BASE, track: null, geometrySource: null, routeVersion: null }).version).toBe(1);
    expect(buildRoutePassport({ ...BASE, track: SURVEYED, geometrySource: 'osm' }).version).toBe(3);
  });

  it('списковый грейд: линия без источника — unknown, не sketch и не surveyed', () => {
    expect(lineGradeForList(true, 'idilesom')).toBe('surveyed');
    expect(lineGradeForList(true, 'waypoints_synthetic')).toBe('sketch');
    expect(lineGradeForList(true, null)).toBe('unknown');
    expect(lineGradeForList(false, null)).toBe('points_only');
    expect(lineGradeForList(false, null, false)).toBe('none');
  });

  it('gradeFromSource — те же замкнутые множества, что у trackLine', () => {
    expect(gradeFromSource('waypoints_synthetic')).toBe('sketch');
    expect(gradeFromSource('gpx')).toBe('surveyed');
    expect(gradeFromSource('чей-то-новый-источник')).toBeNull();
    expect(gradeFromSource(null)).toBeNull();
  });
});

describe('слова паспорта обещают только то, что есть', () => {
  it('«Открыть навигатор» — только снятому треку', () => {
    expect(passportCtaLabel('surveyed')).toBe('Открыть навигатор');
    for (const g of ['sketch', 'unknown', 'points_only', 'none'] as const) {
      expect(passportCtaLabel(g)).toBe('Открыть ориентирование');
    }
  });

  it('оговорки нет только у трека; у остальных — словами', () => {
    expect(passportGradeNote('surveyed')).toBe('');
    for (const g of ['sketch', 'unknown', 'points_only', 'none'] as const) {
      expect(passportGradeNote(g)).not.toBe('');
    }
  });

  it('у каждого рода — короткое имя для бейджа', () => {
    for (const g of ['surveyed', 'sketch', 'unknown', 'points_only', 'none'] as const) {
      expect(passportGradeLabel(g).length).toBeGreaterThan(0);
    }
  });
});

describe('пространство id выбора маршрута едино (VIEW: COALESCE(ark_id, id))', () => {
  it('поиск отдаёт id в пространстве VIEW и находит по обоим id', () => {
    const src = read('app/api/routes/search/route.ts');
    expect(src).toMatch(/COALESCE\(r\.ark_id, r\.id\) AS id/);
    expect(src).toMatch(/r\.ark_id = ANY\(\$1::uuid\[\]\)/);
  });

  it('детальный эндпоинт находит строку kamchatka_routes по обоим id', () => {
    const src = read('app/api/routes/[id]/route.ts');
    expect(src).toMatch(/kr\.id = ark\.id OR kr\.ark_id = ark\.id/);
    // Внутренние таблицы (waypoints, marketplace, view_count) ищутся по
    // каноническому id строки, а не по id VIEW.
    expect(src).toMatch(/routeDbId/);
  });

  it('каталог: has_waypoints и род линии идут через строку маршрута по обоим id', () => {
    const src = read('lib/routes/catalog-query.ts');
    // По обоим id, независимо от имени алиаса: условие has_waypoints
    // переписывалось (16.08 — требование двух точек), смысл не менялся.
    expect(src).toMatch(/\bkw\d*\.id = ark\.id OR kw\d*\.ark_id = ark\.id/);
    expect(src).toMatch(/krl\.id = ark\.id OR krl\.ark_id = ark\.id/);
  });
});

describe('паспорт доехал до выбора маршрута', () => {
  const client = read('app/planning/_PlanningClient.tsx');

  it('детальный эндпоинт отдаёт passport', () => {
    expect(read('app/api/routes/[id]/route.ts')).toMatch(/buildRoutePassport/);
  });

  it('списки отдают род линии', () => {
    expect(read('app/api/routes/search/route.ts')).toMatch(/lineGradeForList/);
    expect(read('lib/routes/catalog-query.ts')).toMatch(/lineGradeForList/);
  });

  it('в выборе маршрута — бейдж рода данных и оговорка словами', () => {
    expect(client).toMatch(/GradeChip/);
    expect(client).toMatch(/passportGradeNote/);
  });

  it('CTA фиксации — из общего правила, не захардкожен', () => {
    // 17.08 подпись действия переехала с рода линии на вердикт черты
    // (lib/routes/navigability): род линии не знает о расхождении точек с
    // линией, а «Открыть навигатор» обещает ведение и на таком маршруте
    // обещать его нельзя.
    expect(client).toMatch(/navigabilityCtaLabel/);
    // Комментарии вырезаются: старая подпись упоминается в пояснениях.
    const code = client.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/Начать по маршруту/);
  });
});

describe('редакция маршрута (миграция 863)', () => {
  const mig = read('migrations/863_route_version.sql');

  it('колонка и триггеры заведены идемпотентно', () => {
    expect(mig).toMatch(/ADD COLUMN IF NOT EXISTS route_version/);
    expect(mig).toMatch(/CREATE OR REPLACE FUNCTION bump_route_version/);
    expect(mig).toMatch(/DROP TRIGGER IF EXISTS trg_route_version_geometry/);
    expect(mig).toMatch(/DROP TRIGGER IF EXISTS trg_route_version_waypoints/);
  });

  it('версия растёт от правки линии И от правки точек', () => {
    expect(mig).toMatch(/UPDATE OF geometry ON kamchatka_routes/);
    expect(mig).toMatch(/INSERT OR UPDATE OR DELETE ON route_waypoints/);
  });
});
