/**
 * Чек-лист снаряжения по маршруту и дате — из данных, без модели (21.11,
 * слово владельца «го»: «смотрю основные уходы с чеклиста»).
 *
 * До этого список писала языковая модель: от нескольких секунд до сорока,
 * иногда «AI вернул некорректный ответ», и промпт требовал «один конкретный
 * совет Кузьмича, специфичный для маршрута» и «критичное предупреждение»,
 * не давая ей данных, — заказ на выдумку (CLAUDE.md §4.0, §8: критичные
 * факты — только из базы). Погоду по сезону он тоже называл числами без
 * источника («мороз −5…−15 °C»).
 *
 * Теперь в списке только то, что записано:
 *   — снаряжение из паспорта маршрута (`kamchatka_routes.equipment`), как
 *     записано; нет — «паспорт снаряжения не называет»;
 *   — опасности маршрута (`hazards`) словами справочника опасностей;
 *   — обязательные шаги, если они записаны у маршрута: регистрация в МЧС,
 *     территория парка;
 *   — сезон маршрута по паспорту и месяц поездки: вне сезона — так и сказано;
 *   — общий минимум для любого выхода по «Ten Essentials» Службы
 *     национальных парков США — тот же источник, что у подготовки к походу
 *     (lib/preparation/engine.ts), с пометкой, что он общий.
 * Обстановка дня — на карточке маршрута, ссылкой: оценка дня считается на
 * сегодня, а не на дату поездки.
 */
import { hazardLabel } from '@/lib/safety/hazard-labels';

export interface GearRouteFacts {
  id: string;
  title: string;
  /** Снаряжение из паспорта маршрута; null — не записано. */
  equipment: readonly string[] | null;
  /** Ключи опасностей маршрута; null — не записаны. */
  hazards: readonly string[] | null;
  mchsRequired: boolean;
  parkName: string | null;
  /** Сезон маршрута по паспорту: summer / winter / all или текст; null — не записан. */
  season: string | null;
  /** Лучшие месяцы по паспорту, названиями; пусто — не записаны. */
  bestMonths: readonly string[];
}

export interface GearChecklist {
  routeTitle: string;
  routeHref: string;
  prepareHref: string;
  /** Месяц поездки словами: «декабрь». */
  monthLabel: string;
  /** Поездка вне сезона маршрута по паспорту — фраза; иначе null. */
  offSeason: string | null;
  /** Снаряжение из паспорта; null — паспорт его не называет. */
  passportEquipment: string[] | null;
  /** Опасности маршрута словами справочника; пусто — не записаны. */
  hazards: string[];
  /** Обязательные шаги до выхода, если записаны у маршрута. */
  steps: { title: string; href: string }[];
  essentials: readonly { name: string; why: string }[];
}

/** Общий минимум любого выхода — NPS Ten Essentials (источник назван на экране). */
export const ESSENTIALS: readonly { name: string; why: string }[] = [
  { name: 'Навигация: офлайн-карта маршрута, компас', why: 'связи на маршруте может не быть' },
  { name: 'Фонарь и запасные батарейки', why: 'задержка до темноты' },
  { name: 'Защита от солнца: очки, крем', why: 'снег и вода отражают солнце' },
  { name: 'Аптечка', why: 'первая помощь до прихода спасателей' },
  { name: 'Нож или мультитул', why: 'ремонт снаряжения, первая помощь' },
  { name: 'Средства для разведения огня', why: 'тепло и сигнал при вынужденной ночёвке' },
  { name: 'Аварийное укрытие: спасательное одеяло или тент', why: 'вынужденная ночёвка' },
  { name: 'Еда сверх плана', why: 'запас на задержку' },
  { name: 'Вода сверх плана или способ её очистки', why: 'запас на задержку' },
  { name: 'Одежда сверх плана: утепляющий и ветрозащитный слой', why: 'погода в горах меняется быстрее, чем в городе' },
];

export const ESSENTIALS_SOURCE = 'общий минимум любого выхода — «Ten Essentials» Службы национальных парков США';

const MONTHS_NOM = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const SUMMER = [6, 7, 8, 9];
const WINTER = [12, 1, 2, 3, 4];

/** Месяц поездки (1–12) из даты YYYY-MM-DD; не дата — null. */
export function tripMonth(dateFrom: string): number | null {
  const m = /^\d{4}-(\d{2})-\d{2}$/.exec(dateFrom);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 12 ? n : null;
}

/**
 * Вне ли сезона маршрута поездка. Судим только записанное: лучшие месяцы
 * названиями, иначе сезон summer / winter. «all», текст без этих слов и
 * пустота — не судим: сказать «в сезоне» значило бы выдумать.
 */
export function offSeasonPhrase(month: number, season: string | null, bestMonths: readonly string[]): string | null {
  const best = bestMonths
    .map((b) => MONTHS_NOM.findIndex((m) => b.toLocaleLowerCase('ru-RU').startsWith(m.slice(0, 3))) + 1)
    .filter((n) => n > 0);
  if (best.length > 0) {
    return best.includes(month) ? null : `Лучшие месяцы по паспорту маршрута: ${bestMonths.join(', ')}. Ваш месяц в них не входит.`;
  }
  const s = (season ?? '').toLowerCase();
  if (s === 'summer' && !SUMMER.includes(month)) return 'По паспорту маршрут летний. Ваша дата вне летнего сезона — условия и снаряжение другие, уточните у гида или оператора.';
  if (s === 'winter' && !WINTER.includes(month)) return 'По паспорту маршрут зимний. Ваша дата вне зимнего сезона — уточните у гида или оператора.';
  return null;
}

export function buildGearChecklist(route: GearRouteFacts, dateFrom: string): GearChecklist | null {
  const month = tripMonth(dateFrom);
  if (month === null) return null;
  const href = `/routes/${encodeURIComponent(route.id)}`;
  const equipment = (route.equipment ?? []).map((e) => e.trim()).filter(Boolean);
  const steps: { title: string; href: string }[] = [];
  if (route.mchsRequired) steps.push({ title: 'Зарегистрировать группу в МЧС — по паспорту маршрута это обязательно', href: '/register' });
  if (route.parkName) steps.push({ title: `Маршрут на территории «${route.parkName}»: условия посещения — на карточке маршрута`, href });
  return {
    routeTitle: route.title,
    routeHref: href,
    prepareHref: `${href}/prepare`,
    monthLabel: MONTHS_NOM[month - 1]!,
    offSeason: offSeasonPhrase(month, route.season, route.bestMonths),
    passportEquipment: equipment.length > 0 ? equipment : null,
    hazards: (route.hazards ?? []).map((h) => hazardLabel(h)).filter(Boolean),
    steps,
    essentials: ESSENTIALS,
  };
}
