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

const ROUTE_UUID = '36c5ef4d-d171-41b9-b1a5-61783b1a3f8e';

describe('ссылка на полевой пакет несёт маршрут', () => {
  it('маршрут известен — он в адресе', () => {
    expect(packItem(ROUTE_UUID).action?.href).toBe(`/planning?mode=trail&route=${ROUTE_UUID}`);
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
    const body = TRAIL.slice(at, at + 900);
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

  /**
   * Ссылку могут переслать, сократить, испортить. Полевой экран назначает по
   * ней маршрут, по которому человек ПОЙДЁТ, и подставляет его в адрес
   * /api/routes/…. Любая строка тут — и не тот маршрут на экране, и чужой
   * путь в запросе.
   */
  it('маршрут из адреса принимается только как UUID', () => {
    expect(TRAIL).toMatch(/if \(route && isUuid\(route\)\)/);
    expect(TRAIL).toMatch(/import \{ isUuid \} from '@\/lib\/text\/slugify'/);
  });

  it('отвергнутый маршрут не проглатывается молча', () => {
    const at = TRAIL.indexOf("params.get('route')");
    expect(TRAIL.slice(at, at + 900)).toMatch(/console\.error\('\[planning\] маршрут из адреса/);
  });
});
