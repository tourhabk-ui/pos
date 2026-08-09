/**
 * Береговая линия Камчатки для радара безопасности.
 *
 * Данные — Natural Earth 10 m (общественное достояние), нарезанные по
 * камчатской рамке и упрощённые Дугласом-Пейкером в `data-coastline.yml`
 * (скрипт `scripts/build-kamchatka-coastline.py`). Файл собирается конвейером,
 * а не пишется руками: прежний контур был ломаной из двух десятков узлов «по
 * памяти», и в круге радиусом 200 км прямые между ними резали экран
 * диагоналями через воду — владелец 09.08: «радар сломан».
 *
 * Упрощение только выбрасывает точки, лежащие ближе порога к прямой между
 * соседями. Линия становится грубее, но не другой: форм, которых нет в
 * источнике, здесь не появляется. Это и есть условие, при котором берег на
 * экране безопасности допустим — он показывает местность, а не рисунок.
 */
import raw from './kamchatka-coastline.json';

/** Точка контура: [долгота, широта] — порядок GeoJSON, как в источнике. */
export type CoastPoint = [number, number];

export interface CoastlineData {
  source: string;
  /** [запад, юг, восток, север] */
  bbox: [number, number, number, number];
  /** Порог упрощения в градусах. */
  epsilonDeg: number;
  /**
   * Несвязные куски берега. Отдельные куски — не мелочь оформления: линия,
   * уходящая за рамку и возвращающаяся, без разрыва замкнулась бы хордой
   * через море.
   */
  parts: CoastPoint[][];
}

export const COASTLINE = raw as CoastlineData;

/**
 * Дальше этого расстояния от центра звено заведомо не заходит в скоп радара
 * (200 км). Половина самого длинного звена контура — около 50 км, поэтому
 * запас четырёхкратный: звено, оба конца которого дальше 400 км, не может
 * приблизиться к центру ближе 350. Порог только экономит разметку, форму он
 * не меняет; инвариант стережёт тест radar-coastline.
 */
const CULL_KM = 400;

const KM_PER_DEG_LAT = 111.32;

/**
 * Готовые SVG-пути берега в системе координат радара.
 *
 * `project` переводит (широта, долгота) в координаты скопа — ту же формулу
 * применяют блипы, поэтому берег и точки всегда в одном масштабе и вместе
 * едут при смене центра.
 *
 * Разрывы сохраняются: между кусками контура пути отдельные. Пробел говорит
 * «здесь берега нет», а сплошная линия говорила бы неправду о местности.
 */
export function coastPaths(
  center: { lat: number; lng: number },
  project: (lat: number, lng: number) => [number, number],
): string[] {
  const kmLng = KM_PER_DEG_LAT * Math.cos((center.lat * Math.PI) / 180);
  const far = (lat: number, lng: number) =>
    Math.hypot((lat - center.lat) * KM_PER_DEG_LAT, (lng - center.lng) * kmLng) > CULL_KM;

  const paths: string[] = [];
  for (const part of COASTLINE.parts) {
    let current: string[] = [];
    for (let i = 0; i < part.length; i++) {
      const [lng, lat] = part[i];
      const prev = part[i - 1];
      const next = part[i + 1];
      // Точку держим, если она сама или любой сосед могут попасть в скоп:
      // выбросить середину звена — значит спрямить берег там, где он изгибается.
      const keep =
        !far(lat, lng) ||
        (prev ? !far(prev[1], prev[0]) : false) ||
        (next ? !far(next[1], next[0]) : false);
      if (!keep) {
        if (current.length > 1) paths.push(current.join(' '));
        current = [];
        continue;
      }
      const [x, y] = project(lat, lng);
      current.push(`${current.length === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`);
    }
    if (current.length > 1) paths.push(current.join(' '));
  }
  return paths;
}
