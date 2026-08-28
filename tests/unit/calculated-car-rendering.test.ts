/**
 * Рендеринг calculated_car после выбора провайдера (владелец 28.08, план
 * "рендеринг calculated_car после выбора провайдера"). Проверяется здесь ЖЕ,
 * что и остальная логика _PlanningClient.tsx (trail-destination-first.test.ts,
 * on-route-honesty.test.ts) — исходным текстом, не рендерингом компонента:
 * тот же приём применён во всём файле для React-логики этого экрана.
 *
 * Три вещи проверяются по коду, а не только по типам:
 *  1. calculated_car НЕ проходит через каталожный fetch /api/routes/[id] —
 *     у него нет записи в базе, синтетический id ничего не идентифицирует.
 *  2. Линия строится ТОЛЬКО через calculatedCarLine() + явный конвертер —
 *     не из wps, не через trackLine(..., 'waypoints_synthetic').
 *  3. mayNavigate/mayPersist первого релиза — реально отсутствующие пути в
 *     коде (нет кнопки старта, нет записи в offline/localStorage/историю),
 *     а не поля ответа, которые экран получил и проигнорировал.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const TRAIL = readFileSync(join(ROOT, 'app/planning/_PlanningClient.tsx'), 'utf-8');

describe('открытие превью calculated_car — локально, без запроса к каталогу', () => {
  it('openPreview ветвится на r.calculated РАНЬШЕ похода за previewCacheRef/fetch', () => {
    const fnAt = TRAIL.indexOf('function openPreview(r: RoutePreview) {');
    expect(fnAt).toBeGreaterThan(-1);
    const branchAt = TRAIL.indexOf('if (r.calculated) {', fnAt);
    const fetchAt = TRAIL.indexOf("fetch(`/api/routes/${r.id}`)", fnAt);
    expect(branchAt).toBeGreaterThan(fnAt);
    expect(fetchAt).toBeGreaterThan(branchAt);
  });

  it('ветка r.calculated возвращается сама (return) и не проваливается к fetch ниже', () => {
    const branchAt = TRAIL.indexOf('if (r.calculated) {');
    const branchEnd = TRAIL.indexOf('const cached = previewCacheRef.current.get(r.id);', branchAt);
    const branchBody = TRAIL.slice(branchAt, branchEnd);
    // Обе внутренние ветки (непригодная геометрия / успех) обязаны return —
    // иначе выполнение продолжится в код каталожного пути ниже.
    expect(branchBody.match(/\breturn;/g)?.length).toBeGreaterThanOrEqual(2);
    expect(branchBody).not.toContain('fetch(');
  });

  it('непригодная геометрия — честное сообщение + диагностика, а не тихий провал', () => {
    expect(TRAIL).toContain('calculatedCarToLeafletCoordinates(r.calculated)');
    expect(TRAIL).toMatch(/setCalculatedPreviewError\('Провайдер вернул непригодную геометрию/);
    expect(TRAIL).toMatch(/console\.error\('calculated_car: непригодная геометрия'/);
  });
});

describe('линия calculated_car строится по стандарту, не из wps', () => {
  it('calculatedPreviewMap зовёт calculatedCarLine() и конвертер, не trackLine', () => {
    const memoAt = TRAIL.indexOf('const calculatedPreviewMap = useMemo(');
    const memoEnd = TRAIL.indexOf('}, [calculatedPreview]);', memoAt);
    const body = TRAIL.slice(memoAt, memoEnd);
    expect(body).toContain('calculatedCarToLeafletCoordinates(route)');
    expect(body).toContain('calculatedCarLine()');
    expect(body).not.toContain('trackLine(');
    expect(body).not.toMatch(/\.wps\b/);
  });

  it('routeOptionToPreview не теряет o.calculated при адаптации к RoutePreview', () => {
    const fnAt = TRAIL.indexOf('function routeOptionToPreview(o: RouteOption): RoutePreview {');
    const fnEnd = TRAIL.indexOf('\n  }', fnAt);
    expect(TRAIL.slice(fnAt, fnEnd)).toMatch(/calculated:\s*o\.calculated/);
  });

  it('renderPathRow для calculated не показывает GradeChip и не читает lineGrade', () => {
    const fnAt = TRAIL.indexOf('function renderPathRow(r: RoutePreview) {');
    const branchAt = TRAIL.indexOf('if (r.calculated) {', fnAt);
    const branchEnd = TRAIL.indexOf('return (\n      <div key={r.id}>', TRAIL.indexOf('return null;\n    }\n    return (', branchAt));
    const branchBody = TRAIL.slice(branchAt, branchAt + 1400);
    expect(branchBody).toContain('Путь на автомобиле');
    expect(branchBody).toContain('Рассчитан сейчас');
    expect(branchBody).not.toContain('<GradeChip');
    expect(branchBody).not.toMatch(/r\.lineGrade/);
  });
});

describe('mayNavigate/mayPersist первого релиза — реальные ограничения, не поля ответа', () => {
  it('превью calculated_car не предлагает кнопку старта маршрута', () => {
    const branchAt = TRAIL.indexOf('calculatedPreview && calculatedPreviewMap ? (');
    const branchEnd = TRAIL.indexOf(') : preview && previewMap ? (', branchAt);
    const branch = TRAIL.slice(branchAt, branchEnd);
    expect(branch).not.toContain('selectRoute(');
    // Ищем именно РЕНДЕРИМУЮ надпись кнопки (>Текст<), а не упоминание фразы
    // в комментарии, объясняющем, почему кнопки здесь намеренно нет.
    expect(branch).not.toMatch(/>\s*Начать маршрут\s*</);
  });

  it('calculatedPreview нигде не передаётся в selectRoute/сохранение офлайн-пакета', () => {
    // selectRoute — единственная точка входа в активный маршрут/офлайн-пакет
    // (owner 27.08). Ни один вызов не должен принимать calculatedPreview.
    const calls = TRAIL.match(/selectRoute\([^)]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).not.toContain('calculatedPreview');
  });

  it('подпись линии выводится буквально из calculatedCarLine(), не укорачивается', () => {
    expect(TRAIL).toContain('{calculatedPreviewMap.caption}');
  });

  it('под картой показаны три обязательных факта: дата, трафик, провайдер', () => {
    const branchAt = TRAIL.indexOf('calculatedPreview && calculatedPreviewMap ? (');
    const branchEnd = TRAIL.indexOf(') : preview && previewMap ? (', branchAt);
    const branch = TRAIL.slice(branchAt, branchEnd);
    expect(branch).toMatch(/Рассчитан \{/);
    expect(branch).toMatch(/Пробки \{/);
    expect(branch).toMatch(/Построил \{/);
  });
});

describe('явный выбор способа передвижения — иначе ветка car недостижима', () => {
  it('переключатель На автомобиле/Пешком существует и меняет buildTravelMode', () => {
    expect(TRAIL).toContain("'На автомобиле'");
    expect(TRAIL).toContain('setBuildTravelMode(m)');
  });

  it('построение пути посылает выбранный режим, не хардкод mode: \'foot\'', () => {
    expect(TRAIL).toContain('mode: buildTravelMode');
    expect(TRAIL).not.toMatch(/build\(\{[^}]*mode: 'foot'/);
  });

  it('заголовок найденного результата называет способ явно в режиме car', () => {
    expect(TRAIL).toContain("'Автомобильный путь от вашего старта'");
  });
});
