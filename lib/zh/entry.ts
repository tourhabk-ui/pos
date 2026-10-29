/**
 * Данные и форматы для китайского входа /zh (app/zh/page.tsx).
 *
 * Вынесено из страницы: Next разрешает page.tsx экспортировать только свои
 * поля (default, metadata, dynamic…), а функции формата нужны сторожу.
 * Витрина — тот же предикат и та же связка с партнёром, что у каталога и
 * sitemap; отказ базы — null и SQLSTATE в лог, страница называет его вслух
 * (§4.0), а не показывает пустой список.
 *
 * Аудит 15.10 (CN-quick), §0: /zh — общая витрина, и порядок у неё один для
 * всех и назван на странице (ZH_TOURS_ORDER_NOTE): по названию компании, внутри
 * — по названию тура. Прежний ORDER BY updated_at DESC тайно поднимал того,
 * кто чаще правит тур. Среза больше нет: заголовок «当前团队游（N）» писал число
 * показанных как общее, и с 41-го тура молча соврал бы.
 *
 * С CN-pages (аудит 15.10) список ведёт на китайские конспекты /zh/tours/*.
 * Китайское название — только свежий перевод (lib/zh/fields, readField);
 * нет перевода — ссылка называется фактом длительности (zhFactHeading),
 * русское название остаётся подписью. Переводы не прочитались — список
 * остаётся, причина в логе.
 */

import { pool } from '@/lib/db-pool';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { logText } from '@/lib/log/log-text';
import { ZH_TOUR_FIELDS, readField } from '@/lib/zh/fields';
import { loadTranslations, logZhFailure } from '@/lib/zh/content';
import { bookingRequestCeiling } from '@/lib/tours/group-size';
import { approxYuan, type CbrRate } from '@/lib/currency/cbr-rate';

export interface ZhTourRow {
  id: string;
  slug: string | null;
  title: string;
  base_price: string | null;
  price_unit: string | null;
  duration_hours: string | null;
  /** Вывеска оператора (partners.name) — ключ порядка, показывается рядом с туром. */
  operator_name: string;
  operator_slug: string | null;
  operator_public: boolean | null;
  /** Китайское название — только свежий перевод; null/нет — показывается русское. */
  title_zh?: string | null;
}

/** Единицы цены — те же три, что считает lib/tours/booking-total. */
export const PRICE_UNIT_ZH: Record<string, string> = {
  per_person: '每人',
  per_tour: '每团',
  per_day_per_person: '每人每天',
};

const RU = new Intl.Collator('ru', { sensitivity: 'base', numeric: true });

/**
 * Единственное правило порядка /zh: название компании, затем название тура,
 * затем id — чтобы равные имена не прыгали между запросами. Ни дата правки,
 * ни цена, ни закрепление в порядок не входят. Новый массив, вход не меняется.
 */
export function orderZhTours<T extends Pick<ZhTourRow, 'id' | 'title' | 'operator_name'>>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) =>
    RU.compare(a.operator_name.trim(), b.operator_name.trim())
    || RU.compare(a.title.trim(), b.title.trim())
    || RU.compare(a.id, b.id));
}

export async function loadZhTours(): Promise<ZhTourRow[] | null> {
  try {
    const { rows } = await pool.query<ZhTourRow>(
      `SELECT ot.id::text AS id, ot.slug, ot.title, ot.base_price::text AS base_price, ot.price_unit,
              ot.duration_hours::text AS duration_hours,
              p.name AS operator_name, p.slug AS operator_slug, p.is_public AS operator_public
         FROM operator_tours ot
         JOIN partners p ON ot.operator_id = p.id
        WHERE ${publicTourSql('ot')}`,
    );
    return orderZhTours(await withZhTitles(rows));
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    console.error('[zh] каталог не прочитан:', typeof code === 'string' ? `SQLSTATE=${logText(code, 10)}` : '', logText(err instanceof Error ? err.message : err, 200));
    return null;
  }
}

/** Китайские названия к строкам списка; отказ чтения переводов — строки без них и лог. */
export async function withZhTitles<T extends ZhTourRow>(rows: T[]): Promise<T[]> {
  let stored: Awaited<ReturnType<typeof loadTranslations>>;
  try {
    stored = await loadTranslations('tour', rows.map((r) => r.id));
  } catch (err) {
    logZhFailure('названия туров для /zh', err);
    return rows;
  }
  return rows.map((r) => {
    const view = readField(ZH_TOUR_FIELDS.title, r.title, stored.get(r.id) ?? new Map(), 'title');
    return view.state === 'fresh' ? { ...r, title_zh: view.zh as string } : r;
  });
}

/**
 * «105,000 卢布 每人»; нет цены или ноль — null, а не «0 卢布».
 *
 * С курсом ЦБ (29.10) — ещё «≈ юани» с датой курса и словами «цена в
 * рублях»: пересчёт подсказка, а не цена. Нет курса — только рубли.
 */
export function priceZh(t: Pick<ZhTourRow, 'base_price' | 'price_unit'>, cny?: CbrRate | null): string | null {
  const n = Number(t.base_price);
  if (!Number.isFinite(n) || n <= 0) return null;
  const rub = `${n.toLocaleString('zh-CN')} 卢布 ${PRICE_UNIT_ZH[t.price_unit ?? ''] ?? PRICE_UNIT_ZH.per_person}`;
  const yuan = cny ? approxYuan(n, cny) : null;
  if (!yuan || !cny) return rub;
  const [d, m, y] = cny.date.split('.');
  return `${rub}（${yuan}，按俄罗斯央行 ${y}-${m}-${d} 汇率估算，以卢布计价）`;
}

/**
 * Заголовок без перевода названия. Это не перевод названия оператора:
 * только слово «团队游» и длительность из базы, если она записана.
 */
export function zhFactHeading(t: Pick<ZhTourRow, 'duration_hours'>): string {
  const d = durationZh(t);
  return d ? `堪察加团队游，${d}` : '堪察加团队游';
}

/**
 * Сниппет страницы, когда прозы по-китайски нет. Цифры — только из полей;
 * нет ни одного — так и сказано, ноль и «уточняйте» не подставляются.
 */
export function zhFactDescription(t: {
  base_price: string | null;
  price_unit: string | null;
  duration_hours: string | null;
  max_participants?: number | string | null;
  group_size_unlimited?: boolean | null;
  season_start?: string | Date | null;
  season_end?: string | Date | null;
}): string {
  const bits = [
    priceZh(t),
    durationZh(t),
    groupZh(t.max_participants, t.group_size_unlimited),
    seasonZh(t.season_start, t.season_end),
  ].filter((x): x is string => Boolean(x));
  const facts = bits.length > 0 ? bits.join('，') : '价格、时长与季节未填写';
  return `堪察加团队游：${facts}。数据来自数据库，未翻译的介绍不在本页。`;
}

/** Часы до суток — часами, дальше — днями; нет длительности — null. */
export function durationZh(t: Pick<ZhTourRow, 'duration_hours'>): string | null {
  const h = Number(t.duration_hours);
  if (!Number.isFinite(h) || h <= 0) return null;
  return h >= 24 ? `约 ${Math.round(h / 24)} 天` : `约 ${Math.round(h)} 小时`;
}

/** Число из DATE 'YYYY-MM-DD' (или Date) — месяц 1–12; чужая форма — null. */
function monthOf(v: string | Date | null | undefined): number | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getMonth() + 1;
  const m = typeof v === 'string' ? /^\d{4}-(\d{2})-\d{2}/.exec(v) : null;
  const n = m ? Number(m[1]) : NaN;
  return n >= 1 && n <= 12 ? n : null;
}

/** Сезон месяцами, как на русской карточке («Июн — Сен»): «6月 – 9月»; нет одной из дат — null. */
export function seasonZh(start: string | Date | null | undefined, end: string | Date | null | undefined): string | null {
  const a = monthOf(start);
  const b = monthOf(end);
  return a && b ? `${a}月 – ${b}月` : null;
}

/**
 * Предел группы из базы: «最多 12 人»; не записан или ноль — null. Группа не
 * ограничена (1342) — «人数不限» и потолок одной заявки на сайте, тем же
 * правилом, что русская карточка (lib/tours/group-size).
 */
export function groupZh(max: number | string | null | undefined, unlimited?: boolean | null): string | null {
  if (unlimited === true) {
    const ceiling = bookingRequestCeiling(max);
    return ceiling === null ? '人数不限' : `人数不限（网站单次申请最多 ${ceiling} 人）`;
  }
  const n = Number(max);
  return Number.isFinite(n) && n > 0 ? `最多 ${Math.round(n)} 人` : null;
}
