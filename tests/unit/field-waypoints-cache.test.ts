/**
 * Полевой кэш точек: пустота перезаписывает так же, как непустота.
 *
 * Полевой скрин владельца 21.08: у «Скал Три Брата» снова 142.3 км хода —
 * через сутки после того, как все 23 городские связи честно стали «рядом»
 * (проба 119: nearby 23, unknown 0, waypoint 0). Данные были правильные;
 * врал КЭШ: код обновлял стейт и localStorage только при непустом списке
 * точек (`if (converted.length > 0)`), и телефон, однажды скачавший 23
 * «этапа», жил на них вечно. «Ноль путевых точек» — законный результат
 * (путь описан треком), а не отказ, и он обязан доезжать до кэша.
 *
 * Ход при нуле точек не теряется: точками становятся начало и конец
 * снятой линии — ведение вдоль трека, дистанция по треку.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(process.cwd(), 'app/planning/_PlanningClient.tsx'), 'utf-8');

describe('пустой список путевых точек — результат, а не отказ', () => {
  it('стейт и кэш не спрятаны за проверкой непустоты', () => {
    expect(src).not.toContain('if (converted.length > 0)');
  });

  it('ранний return при отсутствии точек убран — пустота доезжает до кэша', () => {
    expect(src).not.toMatch(/!Array\.isArray\(wps\) \|\| wps\.length === 0\) return/);
  });

  it('при нуле точек ход ведут начало и конец снятой линии', () => {
    expect(src).toContain("name: 'Начало трека'");
    expect(src).toContain("name: 'Конец трека'");
  });
});

describe('план офлайн-пакета запрашивается и для точки без waypoints (04.09)', () => {
  // Скрин из поля: «Верхне-Опальские термальные источники» — точка-сущность
  // (agent_route_knowledge/places), без route_waypoints и без трека.
  // `effective` — пустой массив, и `loadMapPlan` не вызывался никогда: кнопка
  // «Сохранить полевой пакет» не появлялась не потому, что офлайн-пакет для
  // точки не предусмотрен (offline-bundle умеет bbox вокруг lat/lng места),
  // а потому что фронтенд не спрашивал.
  it('загрузка плана не заперта на непустой effective', () => {
    expect(src).not.toMatch(/if \(effective\.length > 0\) \{\s*\n\s*void loadMapPlan/);
  });

  it('план запрашивается и по собственным координатам сущности', () => {
    expect(src).toMatch(/hasOwnCoords/);
    expect(src).toMatch(/effective\.length > 0 \|\| hasOwnCoords/);
  });
});

describe('кэш точек версионирован — старое знание не оживает', () => {
  it('читается ключ версии v2, а прежний ключ вычищается', () => {
    const src = readFileSync(
      join(process.cwd(), 'app/planning/_PlanningClient.tsx'), 'utf-8',
    );
    expect(src).toContain('trail_route_wps_v2_${routeId}');
    expect(src).toMatch(/removeItem\(`trail_route_wps_\$\{routeId\}`\)/);
  });
});
