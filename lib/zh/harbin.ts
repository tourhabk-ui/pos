/**
 * Страница «从哈尔滨飞往堪察加» (слово владельца 25.10).
 *
 * Факты рейса и безвиза — только те, что назвал владелец и что стоят на
 * официальных страницах, на которые страница ссылается. Часы вылета сюда
 * не копируются: на сайте авиакомпании они уже расходятся между рейсами,
 * и застывшая цифра стала бы враньём. Туры «суббота–суббота» — живые туры
 * витрины, у которых в базе записана длительность 7 или 8 дней. Нет
 * длительности — в список не берём и «недельным» не называем.
 */

import { pool } from '@/lib/db-pool';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { nearestFreeDateSql } from '@/lib/tours/nearest-free-date';
import { logText } from '@/lib/log/log-text';
import { orderZhTours, withZhTitles, type ZhTourRow } from '@/lib/zh/entry';

export const HARBIN_PATH = '/zh/harbin';

export const HARBIN_PAGE = {
  title: '从哈尔滨飞往堪察加：伊尔航空周六航班与一周团队游｜Vedar 堪察加',
  description: '伊尔航空周六航班哈尔滨往返堪察加，约3.5小时。中国公民普通护照免签至多30天（总统令第872号，至2027-12-31）。一周团队游来自数据库。',
  h1: '从哈尔滨飞往堪察加',
  intro: '下列航班与入境规则来自航空公司和总统令，不是平台的报价。团队游是数据库里时长为 7 或 8 天的在售产品：周六抵达、下周六离开，在堪察加停留一周。',
  flightHeading: '航班',
  flight: '伊尔航空（IrAero）航班 IO-771 与 IO-772：哈尔滨 ↔ 彼得罗巴甫洛夫斯克-堪察加斯基，周六，空中约 3.5 小时。',
  flightDirection: '航空公司航线页列出彼得罗巴甫洛夫斯克飞往哈尔滨的 IO-771。一对中的另一个航班号是 IO-772。钟点以航空公司页面为准，本页不抄录。',
  flightSince: '航空公司 2026-09-03 的新闻：自 2026-10-24 起每周六飞行，约 3.5 小时，双向。',
  visaHeading: '入境',
  visa: '持普通护照的中华人民共和国公民，可免签入境并停留至多 30 天（旅游、商务、私人访问、参加活动或过境）。',
  visaUntil: '依据俄罗斯总统令第872号（2025-12-01）；第499号（2026-07-20）将期限改为至 2027-12-31（含当日）。',
  visaExcept: '不适用于工作（含记者）、学习、在俄居住，以及国际公路运输的司机、乘务、押运和随车翻译。见总统令第2条。',
  toursHeading: '周六至周六的一周团队游',
  toursNote: '周六抵达、下周六离开，在堪察加停留 7 天。下列团队游在数据库中的时长为 7 或 8 天。时长未填写的不列入，也不称为适合该航班。具体日期以旅行社页面为准。价格来自数据库。',
  toursEmpty: '目前没有时长为 7 或 8 天的在售团队游。',
  sourcesHeading: '出处',
} as const;

export const HARBIN_SOURCES: readonly { label: string; url: string }[] = [
  {
    label: '伊尔航空新闻：直飞哈尔滨，周六，约 3.5 小时（2026-09-03）',
    url: 'https://iraero.ru/about/news/pryamoy-reys-kamchatka-kharbin-iraero-otkryla-prodazhu-biletov/',
  },
  {
    label: '伊尔航空航线页：彼得罗巴甫洛夫斯克–哈尔滨（含 IO-771）',
    url: 'https://iraero.ru/routs/petropavlovsk-kamchatskiy_kharbin/',
  },
  {
    label: '总统令第872号（克里姆林宫）',
    url: 'http://kremlin.ru/acts/bank/52641',
  },
  {
    label: '总统令第499号：期限延至 2027-12-31（克里姆林宫）',
    url: 'http://kremlin.ru/acts/bank/53446',
  },
];

/**
 * 7 или 8 суток между субботними рейсами. Сначала число дней оператора
 * (`multi_day_count`). Его нет — сутки из часов, тем же округлением, что
 * `durationZh` (карточка уже пишет «约 N 天»). Нет ни того ни другого — null,
 * не «один день».
 */
export function tourLengthDays(t: {
  duration_type?: string | null;
  multi_day_count?: number | string | null;
  duration_hours?: string | number | null;
}): number | null {
  if (t.duration_type === 'multi_day') {
    const n = Number(t.multi_day_count);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  const h = Number(t.duration_hours);
  if (!Number.isFinite(h) || h < 24) return null;
  return Math.round(h / 24);
}

export function isSaturdayWeekTour(days: number | null): boolean {
  return days === 7 || days === 8;
}

interface WeekRow extends ZhTourRow {
  duration_type: string | null;
  multi_day_count: number | null;
}

/** Живые туры на неделю между субботами. null — база не ответила. */
export async function loadSaturdayWeekTours(): Promise<ZhTourRow[] | null> {
  try {
    const { rows } = await pool.query<WeekRow>(
      `SELECT ot.id::text AS id, ot.slug, ot.title, ot.base_price::text AS base_price, ot.price_unit,
              ot.duration_hours::text AS duration_hours, ot.duration_type, ot.multi_day_count,
              p.name AS operator_name, p.slug AS operator_slug, p.is_public AS operator_public,
              ${nearestFreeDateSql('ot')} AS nearest_free_date
         FROM operator_tours ot
         JOIN partners p ON ot.operator_id = p.id
        WHERE ${publicTourSql('ot')}`,
    );
    const week = rows.filter((r) => isSaturdayWeekTour(tourLengthDays(r)));
    return orderZhTours(await withZhTitles(week));
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    console.error('[zh] недельные туры Харбина не прочитаны:', typeof code === 'string' ? `SQLSTATE=${logText(code, 10)}` : '', logText(err instanceof Error ? err.message : err, 200));
    return null;
  }
}
