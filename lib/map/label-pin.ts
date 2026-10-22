/**
 * Пин с подписью — кружок с числом («1», «2», «3») для Leaflet divIcon.
 *
 * Зачем отдельный вид. На карте планировщика дни плана рисовались тем же
 * кружком, что и фоновые точки маршрутов, и красились в синий — ровно тот,
 * в который из-за мёртвого поля `preset` красились все фоновые точки
 * (22.10). Номер дня жил только во всплывающей подсказке, а её выключал
 * `suppressBalloon`. Отличить «мой день 2» от «какой-то маршрут» было нечем.
 *
 * Пин с подписью крупнее точки, с белой кромкой и белым числом, стоит поверх
 * остальных пинов (zIndexOffset у вызывающего) и в кластер не уходит: номер
 * дня, спрятанный в «12» кластера, не читается.
 *
 * Только разметка и размер — без Leaflet, чтобы правило проверялось вызовом.
 */
import { escapeHtml } from '@/lib/text/escape-html';
import { MARKER_HEX } from '@/lib/map/marker-colors';

/** Диаметр кружка в CSS-пикселях: обычный и выделенный (день, который правят). */
export const LABEL_PIN_SIZE = { normal: 28, emphasis: 34 } as const;

/** Кружок фоновой точки (placeMarkerSvg, вид `other`) — 20 px; пин с числом обязан быть крупнее. */
export const PLAIN_PIN_DIAMETER = 20;

/** Хекс, который можно вставить в стиль, не открыв атрибут. Иначе — запасной цвет. */
const SAFE_HEX = /^#[0-9a-fA-F]{3,8}$/;

export function labelPinSize(emphasis = false): number {
  return emphasis ? LABEL_PIN_SIZE.emphasis : LABEL_PIN_SIZE.normal;
}

/**
 * Размер пина под подпись. Одна-две цифры — круг; подпись длиннее («1·7»,
 * «2–4·9») — капсула той же высоты, шире под текст, чтобы номера не
 * обрезались и не налезали на кромку.
 */
export function labelPinBox(label: string, emphasis = false): { width: number; height: number } {
  const height = labelPinSize(emphasis);
  if (label.length <= 2) return { width: height, height };
  // ~7 px на знак при 11 px жирного + поля по 7 px с каждой стороны.
  return { width: Math.max(height, label.length * 7 + 14), height };
}

/**
 * HTML кружка с числом. Подпись экранируется, цвет принимается только хексом
 * (иначе — синий из таблицы пинов): разметка уходит в innerHTML иконки.
 */
export function labelPinHtml(label: string, hex: string, emphasis = false): string {
  const fill = SAFE_HEX.test(hex) ? hex : MARKER_HEX.darkBlue;
  const { width, height } = labelPinBox(label, emphasis);
  const text = escapeHtml(label);
  const fontSize = label.length >= 3 ? 11 : emphasis ? 15 : 13;
  const ring = emphasis ? 3 : 2;
  // Выделенный пин — ещё и ореол его же цвета: «этот день сейчас правят».
  const haloColor = fill.length === 7 ? `${fill}59` : 'rgba(0,0,0,0.25)';
  const halo = emphasis ? `0 0 0 4px ${haloColor}, ` : '';
  return `<div style="width:${width}px;height:${height}px;box-sizing:border-box;border-radius:${height / 2}px;white-space:nowrap;`
    + `background:${fill};border:${ring}px solid #fff;box-shadow:${halo}0 2px 6px rgba(0,0,0,0.35);`
    + `display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;`
    + `font-size:${fontSize}px;line-height:1;font-family:inherit">${text}</div>`;
}
