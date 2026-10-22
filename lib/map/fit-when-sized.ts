/**
 * Когда подгонять вид карты под маркеры.
 *
 * Карта планировщика на телефоне монтируется скрытой: колонка карты стоит
 * `hidden`, пока открыта вкладка «План». Маркеры приходили в контейнер 0×0,
 * `fitBounds` на нулевом размере выбирал максимальный зум, и подгонка
 * помечалась сделанной навсегда. Вкладка «Карта» открывалась на 17-м зуме
 * над пустым местом: ни одной точки на экране, только «+/−» (замер 22.10:
 * 0 из 28 маркеров в окне, тайлы 17/123365/41993).
 *
 * Правило: на нулевом размере подгонять НЕЛЬЗЯ — нужно дождаться размера и
 * подогнать тогда. Подгонка по-прежнему одна на инстанс карты: набор
 * маркеров меняется на каждом GPS-фиксе, и вид не должен уезжать из-под руки.
 */

export type FitDecision =
  /** Подогнано раньше (или вид восстановлен) — больше не трогать. */
  | 'done'
  /** Меньше двух точек — подгонять не по чему. */
  | 'too_few'
  /** Контейнер без размера (скрыт) — отложить до первого настоящего размера. */
  | 'wait_for_size'
  /** Подогнать сейчас. */
  | 'fit';

export function fitDecision(input: { fitDone: boolean; points: number; width: number; height: number }): FitDecision {
  if (input.fitDone) return 'done';
  if (input.points < 2) return 'too_few';
  if (!(input.width > 0) || !(input.height > 0)) return 'wait_for_size';
  return 'fit';
}

/** Прямоугольник на экране — то, что отдаёт getBoundingClientRect. */
interface Box { top: number; bottom: number; left: number; right: number }

/**
 * Верхнее поле подгонки, когда поверх верха карты лежит панель (легенда
 * планировщика на телефоне, ревью 22.10): точки ложатся ниже её нижнего
 * края, а не под стекло. Панель шириной меньше половины карты (легенда на
 * компьютере, слева) поля заранее не получает — она закрывает угол, а не
 * полосу; что под углом не легла точка, проверяет cornerRefitTop после
 * подгонки. Панель скрыта или ниже верха карты — обычное поле.
 */
export function fitPaddingTop(panel: Box, map: Box, base: number): number {
  const mapWidth = map.right - map.left;
  const overlap = Math.min(panel.right, map.right) - Math.max(panel.left, map.left);
  const visible = panel.bottom > panel.top && overlap > 0;
  if (!visible || mapWidth <= 0 || overlap < mapWidth / 2) return base;
  return clearBelow(panel, map, base);
}

/** Верхнее поле, при котором точки ложатся ниже нижнего края панели. */
function clearBelow(panel: Box, map: Box, base: number): number {
  const below = panel.bottom - map.top;
  if (below <= 0) return base;
  // Карта низкая, панель высокая: поле не больше 60% высоты карты, иначе
  // подгонять было бы не во что (Leaflet ушёл бы на самый мелкий зум).
  const cap = Math.round((map.bottom - map.top) * 0.6);
  return Math.max(base, Math.min(Math.round(below) + base / 2, cap));
}

/** Сколько пикселей вокруг панели ещё считается «под ней»: пин шире своей точки. */
export const PIN_REACH = 12;

/**
 * Угловая панель (уже половины карты — легенда планировщика на компьютере)
 * поля заранее не получает: обычно под ней пусто, и сжимать весь вид ради
 * угла незачем. Но вытянутая вверх рамка Камчатки кладёт самую северную
 * точку ровно в этот угол, под плотное стекло (ревью 22.10, третий круг:
 * 1280×800, точка района вне четырёх зон под правым краем легенды). Поэтому
 * после подгонки смотрят, где легли точки: какая-то под панелью (с запасом
 * на ширину пина) — подгонку повторяют с верхним полем по низу панели.
 *
 * `points` — положения точек в пикселях карты ПОСЛЕ обычной подгонки.
 * Отдаёт верхнее поле для повтора или null, если повторять не нужно (панели
 * нет, она широкая — её уже учёл fitPaddingTop, или под ней ни одной точки).
 */
export function cornerRefitTop(
  panel: Box, map: Box, base: number, points: ReadonlyArray<{ x: number; y: number }>,
): number | null {
  const mapWidth = map.right - map.left;
  const overlap = Math.min(panel.right, map.right) - Math.max(panel.left, map.left);
  const visible = panel.bottom > panel.top && overlap > 0;
  if (!visible || mapWidth <= 0 || overlap >= mapWidth / 2) return null;
  if (panel.bottom - map.top <= 0) return null;
  // Панель в координатах карты, с запасом на пин.
  const left = panel.left - map.left - PIN_REACH;
  const right = panel.right - map.left + PIN_REACH;
  const top = panel.top - map.top - PIN_REACH;
  const bottom = panel.bottom - map.top + PIN_REACH;
  const hidden = points.some(p => p.x >= left && p.x <= right && p.y >= top && p.y <= bottom);
  if (!hidden) return null;
  const refit = clearBelow(panel, map, base);
  return refit > base ? refit : null;
}
