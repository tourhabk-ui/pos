/**
 * Что взять в день плана по прогнозу (#3394, п.6, слово владельца 19.11
 * «2 да»: только на дни в пределах прогноза).
 *
 * До этой правки прогноз к дням плана движок получал (`weatherForecast`), но
 * человек его не видел: поле уходило только в промпт модели. Здесь — одна
 * строка дня: что обещает прогноз и что из этого следует взять. Дня за
 * горизонтом прогноза строка не касается: прогноза нет — строки нет, вещи из
 * климата не выдумываются (§4.0).
 *
 * Пороги — правила вещей, а не факты о погоде:
 *  - осадки от 1 мм за сутки — дождевик (или снег — непромокаемая обувь);
 *  - ветер от 10 м/с — ветрозащита;
 *  - ночью до +5 °C — тёплый слой;
 *  - днём от +20 °C при ясной погоде — защита от солнца;
 *  - у дня с подъёмом (вулкан, треккинг, гора) — что на вершине холоднее:
 *    в стандартной атмосфере (ICAO) температура падает на 6,5 °C на
 *    километр высоты. Высоты вершины день не знает — число не подставляется.
 *
 * Чистый модуль: читают движок (lib/planner/engine) и тесты.
 */

export interface KitForecast {
  tempMax: number;
  tempMin: number;
  precipMm: number;
  windKmh: number;
  code: number;
  description: string;
}

/** Занятия с подъёмом: на вершине холоднее, чем в прогнозе для зоны. */
const CLIMB = new Set(['volcano', 'trekking', 'mountain']);
/** Коды WMO со снегом: 71–77 — снег, 85–86 — снежные ливни. */
const SNOW = (code: number) => (code >= 71 && code <= 77) || code === 85 || code === 86;
/** Ясно и малооблачно (WMO 0–2). */
const CLEAR = (code: number) => code >= 0 && code <= 2;

const signed = (t: number) => {
  const r = Math.round(t);
  return r > 0 ? `+${r}` : String(r);
};

/**
 * Что взять — закрытый список вещей строки дня. Общий блок плана сводит
 * советы всех дней в одну строку по этим вещам (слово владельца 22.11:
 * «совет по одежде один раз»).
 */
export const KIT_ITEMS = [
  'непромокаемую обувь и гамаши от снега',
  'дождевик и непромокаемую обувь',
  'ветрозащитную куртку',
  'тёплый слой — флис или пуховку, шапку и перчатки',
  'солнцезащитный крем, очки и головной убор',
] as const;

/** Строка дня или null, если строить её не из чего. */
export function weatherKitLine(fc: KitForecast, activityType?: string | null): string | null {
  const values = [fc.tempMax, fc.tempMin, fc.precipMm, fc.windKmh, fc.code];
  if (values.some((v) => typeof v !== 'number' || !Number.isFinite(v))) return null;
  const windMs = Math.round(fc.windKmh / 3.6);
  const precip = Math.round(fc.precipMm * 10) / 10;
  const facts = [
    fc.description.trim() || null,
    `${signed(fc.tempMin)}…${signed(fc.tempMax)} °C`,
    precip > 0 ? `осадки ${String(precip).replace('.', ',')} мм` : 'без осадков',
    `ветер до ${windMs} м/с`,
  ].filter(Boolean);

  const take: string[] = [];
  if (fc.precipMm >= 1) take.push(SNOW(fc.code) ? KIT_ITEMS[0] : KIT_ITEMS[1]);
  if (windMs >= 10) take.push(KIT_ITEMS[2]);
  if (fc.tempMin <= 5) take.push(KIT_ITEMS[3]);
  if (fc.tempMax >= 20 && CLEAR(fc.code)) take.push(KIT_ITEMS[4]);

  let line = `Прогноз для зоны дня: ${facts.join(', ')}.`;
  if (take.length > 0) line += ` Возьмите ${take.join(', ')}.`;
  if (activityType && CLIMB.has(activityType)) {
    line += ' На вершине холоднее прогноза: около 6,5 °C на каждый километр подъёма.';
  }
  return line;
}
