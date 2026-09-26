/**
 * Сторож: карта поля показывает МАРШРУТ, а выбор «куда» живёт на плане.
 *
 * Повод — скрин владельца 13.09 с экрана «На маршруте»: выбранный маршрут
 * рисовался поверх всего реестра мест района, и владелец написал ровно то,
 * что видел: «когда не знаешь куда, сложно выбрать на этой карте... нужен
 * предварительный поиск... а то получается всё в одной карте и очень сложно
 * ориентироваться... сначала план».
 *
 * Два разных вопроса сидели на одном экране:
 *   «куда мне пойти вообще» — вопрос планирования, и отвечать на него
 *   выщипыванием иконки из трёхсот на карте края нельзя; у него должен быть
 *   поиск словом, и он должен быть НА ПЛАНЕ;
 *   «куда мне шагать сейчас» — вопрос поля, и карта поля обязана отвечать
 *   именно на него: линия, её точки, моя позиция.
 *
 * Решение владельца в тот же день — «только маршрут»: слой всех мест выключен
 * по умолчанию и включается тумблером, когда нужен контекст.
 *
 * Сторож держит обе половины и третье состояние поиска (§4.0): «не смогли
 * спросить» — не «ничего не нашлось».
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const screen = readFileSync(join(ROOT, 'app/planning/_PlanningClient.tsx'), 'utf-8');
const button = readFileSync(join(ROOT, 'components/field/PlacesLayerButton.tsx'), 'utf-8');

describe('карта поля: слой всех мест не включён сам собой', () => {
  it('тумблер управляет ВИДИМОСТЬЮ слоя, а не адресом (26.09)', () => {
    // До 26.09 тумблер менял адрес слоя, а карта пересоздаётся только при
    // смене темы и рельефа — смену адреса она не замечала, соседние районы и
    // обзор рисовали места всегда. Владелец: «кнопка места не работает».
    expect(screen).not.toMatch(/placesUrl:\s*showAllPlaces\s*\?/);
    expect(screen).toMatch(/placesVisible=\{showAllPlaces\}/);
  });

  it('карта прячет места у ВСЕХ районов, в том числе у соседей, подложенных позже', () => {
    const map = readFileSync(join(ROOT, 'components/shared/VedarMap.tsx'), 'utf-8');
    expect(map).toMatch(/function applyPlacesVisibility\(map: MLMap, visible: boolean\)/);
    expect(map).toMatch(/setLayoutProperty\(l\.id, 'visibility', visible \? 'visible' : 'none'\)/);
    // Свой эффект — срабатывает сразу, не со следующим перемещением карты.
    expect(map).toMatch(/applyPlacesVisibility\(map, placesVisible\);\n  \}, \[ready, placesVisible\]\);/);
    // Соседу — действующее значение сразу при подкладке.
    expect(map).toMatch(/applyPlacesVisibility\(map, placesVisibleRef\.current\)/);
  });

  it('по умолчанию слой ВЫКЛЮЧЕН', () => {
    expect(screen).toMatch(/const \[showAllPlaces, setShowAllPlaces\] = useState\(false\)/);
  });

  it('выбор переживает перезапуск — читается и пишется в localStorage', () => {
    expect(screen).toContain("const ALL_PLACES_KEY = 'field_all_places_v1'");
    expect(screen).toMatch(/getItem\(ALL_PLACES_KEY\)/);
    expect(screen).toMatch(/setItem\(ALL_PLACES_KEY/);
  });

  it('тумблера нет, когда слою нечего показать (пакет без places)', () => {
    // Кнопка, которую нечем включить, обещает слой, которого нет (правило 10.09).
    expect(screen).toMatch(/canTogglePlaces\s*=\s*fieldBaseMap\.kind === 'vedar' && fieldBaseMap\.source\.placesUrl !== null/);
    // Оба места отрисовки — под этим условием.
    const uses = screen.match(/<PlacesLayerButton/g) ?? [];
    expect(uses.length, 'тумблер должен рисоваться в приборном ряду и в режиме «Карта»').toBe(2);
    expect((screen.match(/canTogglePlaces &&/g) ?? []).length).toBe(2);
  });

  it('тумблер непрозрачный — это орган управления, а не слой контекста (§2)', () => {
    expect(button).not.toMatch(/backdrop-blur/);
    expect(button).toMatch(/aria-pressed/);
  });
});

describe('план: поиск «куда» есть и различает отказ от пустоты', () => {
  it('на вкладке планирования есть поле поиска по названию места', () => {
    expect(screen).toMatch(/aria-label="Поиск маршрута по названию места"/);
    // Ищет тот же эндпоинт, что и выбор цели в поле — своего поиска маршрутов
    // здесь заводить нельзя.
    expect((screen.match(/\/api\/routes\/search\?q=/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('у поиска на плане четыре состояния, а не два', () => {
    expect(screen).toMatch(/'idle' \| 'searching' \| 'done' \| 'failed'/);
    expect(screen).toContain('Поиск не дошёл до сервера');
  });

  it('отказ поиска не выдаётся за «ничего не нашлось» — ни на плане, ни в поле', () => {
    // В поле то же состояние держит searchFailed: до 13.09 catch писал
    // пустой список, и оборванная сеть читалась как факт о Камчатке.
    expect(screen).toContain('setSearchFailed(true)');
    expect(screen).not.toMatch(/\.catch\(\(\) => setSearchRoutes\(\[\]\)\)/);
    expect(screen).toContain('Это не значит, что путей нет.');
  });

  it('нерабочий ответ сервера отличается от пустого результата', () => {
    // Без проверки r.ok ответ 500 разбирался как JSON и давал пустой список.
    expect((screen.match(/if \(!r\.ok\) throw new Error\(`HTTP \$\{r\.status\}`\)/g) ?? []).length)
      .toBeGreaterThanOrEqual(2);
  });
});

describe('тумблер слоя говорит, что он делает', () => {
  it('подпись словами, а не только иконка', () => {
    // Владелец 14.09: «что делает кнопка слои». Стопка листов — не
    // общепонятный знак, и узнать её смысл можно было только нажав; нажатие
    // же включает состояние, которое ПОМНИТСЯ между запусками.
    expect(button).toMatch(/>Все места</);
  });

  it('подпись называет СОДЕРЖИМОЕ слоя, а не действие по нажатию', () => {
    // «Скрыть места» на выключенной кнопке читалось бы как утверждение, что
    // места сейчас показаны. Действие остаётся в aria-label и title.
    expect(button).not.toMatch(/>Скрыть места</);
    expect(button).not.toMatch(/>Показать места</);
    expect(button).toMatch(/aria-label=\{label\}/);
  });
});
