/**
 * Destination-first: сначала цель, потом маршрут (UX-коррекция владельца 27.08).
 *
 * Прежний вход на /planning?mode=trail без активного маршрута был
 * приборной панелью с нулями: «Маршрут не выбран» + кнопка, открывающая
 * поиск по месту ВНУТРИ модалки. Поиск по месту (название → сгруппированные
 * пути → превью на карте → фиксация) уже существовал — только был спрятан
 * за клик. Коррекция: тот же самый инструмент показывается СРАЗУ, без
 * модалки и чёрной подложки, а «Добавить место» (полевая находка)
 * переименовано, чтобы не спорить по смыслу с «местом» как целью маршрута.
 *
 * Явно НЕ сделано в этой правке (полноценный переход к состояниям
 * destination_selected/origin_required/route_options как отдельным экранам
 * с построением маршрута от произвольной точки, «указать точку на карте»,
 * «путь не найден → безопасные альтернативы») — эта инфраструктура
 * (поиск МЕСТ отдельно от маршрутов, построение пути от точки, клик по
 * карте для установки цели) в кодовой базе не существует, и симулировать
 * её нерабочими кнопками нельзя (§4.0).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const TRAIL = readFileSync(join(ROOT, 'app/planning/_PlanningClient.tsx'), 'utf-8');

describe('пустое состояние — инструмент выбора цели, не приборная панель', () => {
  it('заголовок и вызов общего пикера, без старой приборной формулировки', () => {
    // Ищем именно JSX-условие (с ведущей `{`), а не любое вхождение этой
    // фразы: она встречается ещё и в useEffect авто-загрузки рекомендаций.
    const condAt = TRAIL.indexOf('{!hasRoute && !isLoadingRoute ? (');
    const emptyState = TRAIL.slice(condAt, TRAIL.indexOf(') : (', condAt));
    expect(emptyState).toContain('Куда хотите пойти?');
    expect(emptyState).toContain('{renderDestinationPicker()}');
    expect(emptyState).not.toContain('Маршрут не выбран');
    expect(emptyState).not.toContain('openRouteModal');
  });

  it('поиск и превью — ОДНА функция, переиспользуемая модалкой и пустым состоянием', () => {
    // Не две копии одной логики выбора: только один источник JSX.
    expect(TRAIL.match(/function renderDestinationPicker/g)?.length).toBe(1);
    expect(TRAIL.match(/\{renderDestinationPicker\(\)\}/g)?.length).toBe(2);
  });

  it('рекомендации грузятся ОДНОЙ функцией — и модалкой, и авто-загрузкой', () => {
    expect(TRAIL.match(/function loadRecommendedRoutes/g)?.length).toBe(1);
    const modalFn = TRAIL.slice(TRAIL.indexOf('function openRouteModal'), TRAIL.indexOf('function openRouteModal') + 200);
    expect(modalFn).toContain('loadRecommendedRoutes()');
    expect(TRAIL).toMatch(/if \(!hasRoute && !isLoadingRoute\) loadRecommendedRoutes\(\)/);
  });

  it('поиск виден без открытой модалки: гейт — pickerVisible, не только showRouteModal', () => {
    expect(TRAIL).toContain('const pickerVisible = showRouteModal || (!hasRoute && !isLoadingRoute)');
    expect(TRAIL).toMatch(/if \(!pickerVisible \|\| q\.length < 2\)/);
  });
});

describe('семантика «места» разведена: цель маршрута vs полевая находка', () => {
  it('полевое действие переименовано в «Сообщить о месте»', () => {
    expect(TRAIL).toContain("label: 'Сообщить о месте'");
    expect(TRAIL).not.toContain("label: 'Добавить место'");
  });

  it('поведение действия не изменилось — та же форма находки на /field-check', () => {
    const at = TRAIL.indexOf("id: 'place'");
    const action = TRAIL.slice(at, TRAIL.indexOf('});', at));
    expect(action).toContain("'/field-check?place=1'");
  });
});
