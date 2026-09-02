// @vitest-environment node
/**
 * Пакет сохраняется ТОМУ маршруту, к которому готовятся (02.09).
 *
 * Экран подготовки вёл на полевой режим ссылкой без маршрута, а тот
 * поднимал ПОСЛЕДНИЙ активный из localStorage. Человек, готовясь к маршруту
 * A, попадал на пакет маршрута B — и заметить подмену можно было только по
 * названию в приборной строке. Сохранённый «не тот» пакет выясняется уже
 * без связи, то есть в единственном месте, где это непоправимо.
 *
 * Скрин владельца 02.09 из поля («Карта не сохранена — в поле не
 * откроется») — тот же разговор с другой стороны: сохранение должно
 * происходить ДО выхода и по нужному маршруту.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildPreparationItems } from '@/lib/preparation/engine';
import type { PrepAnswers } from '@/lib/preparation/types';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const TRAIL = read('app/planning/_PlanningClient.tsx');
const PREPARE = read('app/routes/[id]/prepare/_PrepareClient.tsx');

const ANSWERS: PrepAnswers = {} as PrepAnswers;

function packItem(routeId?: string | null) {
  const items = buildPreparationItems({
    passport: null,
    packStates: null,
    answers: ANSWERS,
    conditionsAgeMs: null,
    userStates: {},
    routeId,
  });
  return items.find(i => i.code === 'field_pack')!;
}

describe('ссылка на полевой пакет несёт маршрут', () => {
  it('маршрут известен — он в адресе', () => {
    expect(packItem('r-42').action?.href).toBe('/planning?mode=trail&route=r-42');
  });

  it('идентификатор экранируется, а не склеивается как есть', () => {
    expect(packItem('a b/c').action?.href).toBe('/planning?mode=trail&route=a%20b%2Fc');
  });

  it('маршрут неизвестен — ссылка прежняя, id не выдумывается', () => {
    expect(packItem(null).action?.href).toBe('/planning?mode=trail');
    expect(packItem().action?.href).toBe('/planning?mode=trail');
  });

  it('экран подготовки передаёт свой routeId движку', () => {
    expect(PREPARE).toMatch(/buildPreparationItems\(\{[\s\S]{0,200}routeId,/);
  });
});

describe('полевой режим принимает маршрут из адреса', () => {
  it('пишет active_trail_route_id до переключения вкладки', () => {
    const at = TRAIL.indexOf("params.get('route')");
    expect(at, 'чтение параметра route не найдено').toBeGreaterThan(0);
    const body = TRAIL.slice(at, at + 400);
    expect(body).toMatch(/localStorage\.setItem\('active_trail_route_id', route\)/);
    // Порядок важен: полевая вкладка читает ключ в своём эффекте
    // монтирования, то есть строго после этого места.
    const setKey = TRAIL.indexOf("localStorage.setItem('active_trail_route_id', route)");
    const setTab = TRAIL.indexOf("params.get('mode') === 'trail'", at);
    expect(setKey).toBeGreaterThan(0);
    expect(setTab).toBeGreaterThan(setKey);
  });

  it('приватный режим не роняет переход — запись в try', () => {
    const at = TRAIL.indexOf("localStorage.setItem('active_trail_route_id', route)");
    expect(TRAIL.slice(at - 60, at + 120)).toMatch(/try \{/);
  });
});
