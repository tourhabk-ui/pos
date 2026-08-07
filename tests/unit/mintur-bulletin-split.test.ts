/**
 * Сводка Минтура о доступности туристических объектов — построчный разбор.
 *
 * До 06.08 сводка (kamgov.ru/mintur/news/operativnaa-svodka-...) целиком
 * схлопывалась в одно info-событие severity 0 с пометкой в коде «построчный
 * разбор — следующий шаг, когда накопятся образцы». Второй образец принёс
 * владелец 07.08 — на нём и построен разбор: закрытые маршруты, опасные
 * вулканы, паводки и медведи доезжают до карточек отдельными событиями.
 *
 * Текст ниже — ЖИВАЯ сводка от 06.08.2026 (передал владелец, источник
 * kamgov.ru/mintur/news/operativnaa-svodka-o-dostupnosti-turisticeskih-obektov-06082026-91530).
 */
import { describe, it, expect } from 'vitest';
import { classifyMchsItems, isMinturBulletin, mchs_zones } from '@/lib/services/safety/seismic-parser';

const TITLE = 'Оперативная сводка доступности туристических объектов от 6 августа';
const BULLETIN = `Перед поездкой по Камчатке обязательно проверьте актуальную обстановку.

Открыты летние маршруты природного парка «Быстринский».
Доступны летние маршруты природного парка «Налычево», но с перекрытием двух маршрутов: «Радыгино — Центральный» и «р. Налычева — р. Островная».
В природном парке «Ключевской» летние маршруты также открыты, но передвижение в районах вулканов крайне небезопасно.

Будьте внимательны на следующих участках:
в «Налычево» закрыты два маршрута из-за паводков, а также на маршруте «Авачинский — Центральный» переход через реку Шумную осуществляется по снежнику;
не рекомендуется посещать вулканы Ключевской, Безымянный, Мутновский, Шивелуч и район вулкана Крашенинникова;
на большинстве рек края наблюдается высокий уровень воды и подтопления;
в с. Соболево действует режим повышенной готовности в связи с выходом медведей в населённый пункт.`;

const events = classifyMchsItems(
  'kamgov/91530', TITLE, BULLETIN, '2026-08-06T10:00:00Z',
  'https://kamgov.ru/mintur/news/operativnaa-svodka-o-dostupnosti-turisticeskih-obektov-06082026-91530',
  'kamgov',
);

describe('живая сводка 06.08 разбирается на события', () => {
  it('сводка распознана как минтуровская', () => {
    expect(isMinturBulletin(`${TITLE} ${BULLETIN}`)).toBe(true);
  });

  it('не схлопывается в один info: событий несколько', () => {
    expect(events.length).toBeGreaterThanOrEqual(4);
    expect(events.every(e => e.alert_type === 'info' && e.severity === 0)).toBe(false);
  });

  it('перекрытые маршруты Налычево — road_closure красного уровня', () => {
    const road = events.find(e => e.alert_type === 'road_closure');
    expect(road, 'закрытие маршрутов потеряно').toBeDefined();
    expect(road!.severity).toBe(2);
    expect(road!.affected_zones).toContain('avachinsky');
  });

  it('«не рекомендуется посещать вулканы …» — вулканическая угроза на ТРИ зоны', () => {
    const volc = events.filter(e => e.alert_type === 'volcanic_eruption');
    expect(volc.length).toBeGreaterThanOrEqual(1);
    const zones = new Set(volc.flatMap(e => e.affected_zones));
    // Ключевской/Безымянный/Шивелуч → northern, Мутновский → avachinsky,
    // Крашенинникова → eastern. Первый-матч оставлял только northern.
    expect(zones).toContain('northern');
    expect(zones).toContain('avachinsky');
    expect(zones).toContain('eastern');
    expect(Math.max(...volc.map(e => e.severity))).toBeGreaterThanOrEqual(2);
  });

  it('высокая вода на реках — flood', () => {
    expect(events.some(e => e.alert_type === 'flood')).toBe(true);
  });

  it('медведи в Соболево — событие западной зоны', () => {
    const bear = events.find(e => /медвед/i.test(`${e.title} ${e.description}`));
    expect(bear, 'медвежий пункт потерян').toBeDefined();
    expect(bear!.affected_zones).toContain('western');
    expect(bear!.severity).toBeGreaterThanOrEqual(1);
  });

  it('пункты «открыто» событий не порождают', () => {
    expect(events.some(e => /Быстринск/i.test(e.title))).toBe(false);
  });
});

describe('фидовые пути зовут множественную форму классификатора', () => {
  it('RSS-конвейеры (МЧС и kamgov) используют classifyMchsItems, не одиночную', () => {
    // 07.08: разбор сводки был готов, но фидовый путь звал classifyMchsItem
    // (единственную форму) — сводка Минтура из kamgov-RSS шла мимо разборщика,
    // и владелец справедливо спросил «где предупреждения с сайта минтуризма».
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    const src = readFileSync(join(process.cwd(), 'lib/services/safety/seismic-parser.ts'), 'utf-8');
    // Одиночная форма как ВЫЗОВ допустима только внутри classifyMchsItems и
    // в разборе соцпостов без заголовка — но не в фидовых циклах по items.
    const feedCalls = src.match(/const event = classifyMchsItem\(/g) ?? [];
    expect(feedCalls, 'фидовый цикл откатился на одиночный классификатор').toHaveLength(0);
    expect((src.match(/classifyMchsItems\(it\.id/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe('зоны объединяются, а не первый матч', () => {
  it('перечисление вулканов трёх зон даёт все три', () => {
    const zones = mchs_zones('не рекомендуется посещать вулканы Ключевской, Мутновский и Крашенинникова');
    expect(new Set(zones)).toEqual(new Set(['northern', 'avachinsky', 'eastern']));
  });

  it('один вулкан — одна зона, дефолт прежний', () => {
    expect(mchs_zones('вулкан Мутновский')).toEqual(['avachinsky']);
    expect(mchs_zones('без географии')).toEqual(['avachinsky']);
  });
});
