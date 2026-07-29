/**
 * Пересборка v_kamchatka_routes_api (миграция 787).
 *
 * Две миграции — 670 и 738 — падали при каждом деплое больше месяца, и обе про
 * это представление. Настоящие причины стали известны только когда раннер
 * миграций начал сохранять текст ошибки в базу:
 *   670 — «cannot change name of view column "route_id" to "id"»;
 *   738 — «cannot drop view because other objects depend on it», при том что
 *         её собственный комментарий утверждал обратное.
 *
 * Аудит боевой схемы дал определения обоих представлений, и главный факт
 * оказался не про починку: живое v_kamchatka_routes_api заканчивалось на
 * `FROM kamchatka_routes kr;` — БЕЗ фильтра. То есть правило CLAUDE.md
 * «читать маршруты только через представление, чтобы наружу не попадали
 * скрытые» держалось на свойстве, которого у представления не было.
 *
 * Тест сторожит именно это свойство, а не текст миграции.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const M787 = readFileSync(join(ROOT, 'migrations/787_route_view_rebuild.sql'), 'utf-8');

/** Тело SELECT нового представления — без комментариев. */
const VIEW_BODY = /CREATE VIEW v_kamchatka_routes_api AS([\s\S]*?);\s*\n/i.exec(M787)?.[1] ?? '';

describe('представление маршрутов скрывает невидимое', () => {
  it('фильтр видимости есть — ради него правило и существует', () => {
    expect(VIEW_BODY, 'объявление представления не разобралось').not.toBe('');
    expect(VIEW_BODY).toMatch(/WHERE\s+is_visible\s*=\s*TRUE\s+OR\s+is_visible\s+IS\s+NULL/i);
  });

  it('отдаёт колонки, которых ждал сломавшийся safety-код', () => {
    // Ровно те, на которых падали computeRescueCoverage,
    // checkRouteOfflineReadiness, findRoutePreflightSafety и offline-bundle.
    for (const col of ['id', 'geometry', 'mchs_phone', 'mchs_registration_required', 'hazards', 'equipment']) {
      expect(VIEW_BODY, `нет колонки ${col}`).toMatch(new RegExp(`\\b${col}\\b`));
    }
  });

  it('сохраняет то, на чём держится агрегат по категориям', () => {
    // v_kamchatka_route_groups_api читает эти три. Не сохранить их — значит
    // уронить зависимый объект, ровно как 738.
    for (const col of ['category', 'has_coordinates', 'source_updated_at']) {
      expect(VIEW_BODY, `нет колонки ${col}`).toMatch(new RegExp(`\\b${col}\\b`));
    }
  });
});

describe('порядок сноса учитывает зависимость', () => {
  it('зависимое представление снимается первым', () => {
    const groupsDrop = M787.indexOf('DROP VIEW IF EXISTS v_kamchatka_route_groups_api');
    const routesDrop = M787.indexOf('DROP VIEW IF EXISTS v_kamchatka_routes_api');
    expect(groupsDrop, 'нет DROP зависимого представления').toBeGreaterThan(-1);
    expect(routesDrop, 'нет DROP основного представления').toBeGreaterThan(-1);
    expect(groupsDrop, 'зависимое надо снимать раньше — иначе повторится отказ 738').toBeLessThan(routesDrop);
  });

  it('зависимое представление создаётся обратно', () => {
    // Кодом оно не используется, но существует на проде — возможный внешний
    // потребитель не должен остаться без него молча.
    expect(M787).toMatch(/CREATE VIEW v_kamchatka_route_groups_api AS/i);
  });
});

describe('старые попытки обезврежены', () => {
  for (const file of ['migrations/670_v_kamchatka_routes_api.sql', 'migrations/738_route_view_final.sql']) {
    it(`${file} больше не трогает представление`, () => {
      const sql = readFileSync(join(ROOT, file), 'utf-8');
      const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
      // Иначе они будут спорить с 787 и падать на каждом деплое дальше.
      expect(code).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?VIEW/i);
      expect(code).not.toMatch(/DROP\s+VIEW/i);
    });
  }
});
