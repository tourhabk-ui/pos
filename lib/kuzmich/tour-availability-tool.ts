/**
 * get_tour_availability — свободные даты и места конкретного тура.
 *
 * Один мозг — два протокола: инструмент живёт в реестре Кузьмича и через него
 * же отдаётся публичному MCP (Эволюция 3.0, п.4 — MCP-бронирование, владелец
 * 08.08: «делай»). Занятость — ТОЛЬКО из fetchAvailabilityForTour (движок
 * планера, реальные брони) — тот же расчёт, что у гейта брони и share-API
 * плана. Свой SQL по tour_availability здесь запрещён: разойдётся с гейтом,
 * и агент пообещает места, по которым бронь отклонят.
 */

import { pool } from '@/lib/db-pool';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { tourKeepsSchedule } from '@/lib/seat-requests/service';
import { getPublicBaseUrl } from '@/lib/config';
import { tourPath } from '@/lib/tours/tour-url';
import { createPlannerCache, fetchAvailabilityForTour } from '@/lib/planner';
import { priceFromUnit } from '@/lib/tours/price-label';
import { containsPattern } from '@/lib/db/like';
import { kamchatkaToday } from '@/lib/seat-requests/core';
import { PriceTierMissError } from '@/lib/tours/price-tiers';
import { honestTourPrice, loadPricingContext, composeHonestPrice } from '@/lib/tours/honest-price';

export interface ResolvedTour {
  id: number;
  title: string;
  operator_id: string | null;
  /** Адрес карточки (ЧПУ, 1114). NULL — только по числу. */
  slug?: string | null;
  base_price: number | null;
  /** За что назначена цена; null — не записано. */
  price_unit: string | null;
  /** Длительность — для цены «за человека в день» (tourDurationDays). */
  multi_day_count?: number | null;
  duration_hours?: number | null;
}

/**
 * Тур по названию/ключевому слову или числовому ID — тот же паттерн, что у
 * get_tour_details. Только тур на витрине (publicTourSql): черновик
 * оператора (is_published = false) через MCP не находился бы ни картой, ни
 * заявкой на бронь — до 29.09 резолвер смотрел лишь is_active и deleted_at.
 * null — такого тура нет; отказ базы — исключение (с
 * логом): до 29.09 он тоже был null, и внешний агент получал ложный факт
 * «тур не найден среди активных» на месте «не смог проверить» (§4.0).
 */
export async function resolveTourByQuery(query: string): Promise<ResolvedTour | null> {
  const q = query.trim();
  if (!q) return null;
  try {
    if (/^\d+$/.test(q)) {
      const { rows } = await pool.query<ResolvedTour>(
        `SELECT id, title, operator_id, base_price, price_unit, slug, multi_day_count, duration_hours FROM operator_tours
          WHERE id = $1 AND ${publicTourSql('')}`,
        [Number(q)],
      );
      // Номер, которого нет на витрине, — это «тура нет», а не повод искать
      // «%7%» по названиям: так заявка на снятый тур 7 уходила по самому
      // дешёвому туру, где в описании есть семёрка (проверка MCP 29.09).
      return rows[0] ?? null;
    }
    const { rows } = await pool.query<ResolvedTour>(
      `SELECT id, title, operator_id, base_price, price_unit, slug, multi_day_count, duration_hours FROM operator_tours
        WHERE ${publicTourSql('')}
          AND (title ILIKE $1 OR short_description ILIKE $1 OR activity_type ILIKE $1 OR location_name ILIKE $1)
        ORDER BY (CASE WHEN title ILIKE $1 THEN 0 ELSE 1 END), base_price ASC NULLS LAST
        LIMIT 1`,
      [containsPattern(q)],
    );
    return rows[0] ?? null;
  } catch (err) {
    const e = err as { code?: string; message?: string };
    console.error('[tour-availability] тур не прочитан', { sqlstate: e?.code, message: e?.message });
    throw err;
  }
}

function shortDate(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${d}.${m}`;
}

/**
 * Сколько человек: 1–30 (тот же потолок, что у группы в регистрации и брони).
 * Не дано или не число — null: итог не считается, а не считается «за одного».
 */
export function parsePeople(raw: string | undefined): number | null {
  if (raw == null || raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const k = Math.trunc(n);
  return k >= 1 && k <= 30 ? k : null;
}

const rub = (n: number) => `${Math.round(n).toLocaleString('ru-RU')} ₽`;

/** Даты окна по порядку, оба края включительно. */
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Подряд идущие даты с одинаковой подписью — одним диапазоном: четырнадцать
 * одинаковых строк агент пересказал бы человеку как четырнадцать фактов.
 * Подпись сменилась (сезонное правило цены с середины окна) — новый диапазон.
 */
export function collapseRuns(items: ReadonlyArray<{ date: string; label: string }>): Array<{ from: string; to: string; label: string }> {
  const runs: Array<{ from: string; to: string; label: string }> = [];
  for (const it of items) {
    const last = runs[runs.length - 1];
    const prevDay = last ? new Date(Date.parse(`${last.to}T00:00:00Z`) + 86400000).toISOString().slice(0, 10) : null;
    if (last && last.label === it.label && prevDay === it.date) last.to = it.date;
    else runs.push({ from: it.date, to: it.date, label: it.label });
  }
  return runs;
}


/**
 * Тур без расписания: все даты окна свободны для заявки (решение владельца
 * 08.10: «сделай все даты свободными, можно только отправить заявку
 * оператору»).
 *
 * До этого инструмент отвечал «свободные даты узнать нельзя» — и внешний
 * агент так и пересказывал человеку все одиннадцать туров «Края Вулканов»:
 * дат нет, ничего не узнать. Правда другая: оператор собирает группу под
 * запрос, и закрытых дат у него нет. Поэтому даты называются свободными —
 * для заявки, с итогом на группу тем же расчётом, что у самой заявки.
 *
 * Чего здесь нет намеренно: числа мест. Календаря у тура нет, и «свободно
 * 10» было бы выдумкой (§4.0). И строк в tour_availability под такие туры
 * никто не заводит: по ним работает автоподтверждение оператора
 * (lib/bookings/auto-confirm), и выдуманный календарь подтверждал бы заявки
 * на даты, которых оператор не давал.
 */
async function onRequestWindow(
  tour: ResolvedTour, from: string, to: string, peopleRaw: string | undefined, notes: string[],
): Promise<string[]> {
  const people = parsePeople(peopleRaw);
  if (peopleRaw != null && peopleRaw.trim() !== '' && people === null) {
    notes.push(`Число людей «${peopleRaw}» не распознано (нужно 1–30) — итог не посчитан.`);
  }
  const dates = datesBetween(from, to);
  let labels: string[];
  if (people !== null && tour.base_price != null) {
    try {
      // Правила цены и ступени группы от даты не зависят — читаются один
      // раз; дата участвует в самом расчёте (сезонные правила).
      const { rules, tiers } = await loadPricingContext(tour.id, from);
      labels = dates.map((d) => {
        try {
          const p = composeHonestPrice({
            baseUnitPrice: Number(tour.base_price), priceUnit: tour.price_unit, participants: people,
            duration: { multi_day_count: tour.multi_day_count ?? null, duration_hours: tour.duration_hours ?? null },
            rules, tiers, ctx: { tourDate: d, guests: people, occupancyPct: 0 },
          });
          return `итого за ${people} чел.: ${rub(p.total)}`;
        } catch (err) {
          if (err instanceof PriceTierMissError) return `для группы из ${people} чел. цену называет оператор`;
          throw err;
        }
      });
    } catch (err) {
      const e = err as { code?: string; message?: string };
      console.error('[tour-availability] итог не посчитан', { tourId: tour.id, sqlstate: e?.code, message: e?.message });
      labels = dates.map(() => 'итог не посчитан');
    }
  } else {
    const price = priceFromUnit(tour.base_price, tour.price_unit);
    labels = dates.map(() => price || 'цену называет оператор');
  }
  const runs = collapseRuns(dates.map((date, i) => ({ date, label: labels[i] })));
  return [
    `Тур "${tour.title}" (ID${tour.id}): расписания в системе нет — все даты свободны для заявки, оператор собирает группу под запрос:`,
    ...runs.map((r) => `- ${r.from === r.to ? shortDate(r.from) : `${shortDate(r.from)}–${shortDate(r.to)}`}: свободно для заявки, ${r.label}`),
    'Числа мест у тура без календаря нет — дату и группу подтверждает оператор. '
      + 'create_booking_request с датой отправит ему заявку в мессенджер, ответ — до 2 часов. Не обещай, что место закреплено, до его ответа.',
    ...(people !== null && tour.base_price != null
      ? ['Итог — сумма, которую посчитает заявка на эту дату и число людей (правила цены тура). Трансферы и услуги из «не входит» в неё не включены.']
      : ['Итоговую сумму за группу на дату даёт этот же инструмент с параметром people.']),
  ];
}

export async function getTourAvailabilityForKuzmich(args: { tour?: string; date_from?: string; days?: string; people?: string }): Promise<string> {
  const tourQuery = (args.tour ?? '').trim();
  if (!tourQuery) return 'Укажи тур: название, ключевое слово или ID.';

  const tour = await resolveTourByQuery(tourQuery);
  if (!tour) {
    return `Тур по запросу "${tourQuery}" не найден среди активных. Не выдумывай даты — предложи выбрать тур через get_tours.`;
  }

  // «Сегодня» — по Камчатке: даты туров местные. По UTC с 12:00 до 24:00
  // сегодняшнее число на Камчатке уже следующее, и инструмент предлагал
  // вчерашний день как свободный (проба MCP 29.09, 22:05 UTC — «29.09
  // свободно 12» при 30.09 на Камчатке).
  const today = kamchatkaToday();
  const pastFrom = /^\d{4}-\d{2}-\d{2}$/.test(args.date_from ?? '') && (args.date_from as string) < today;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(args.date_from ?? '') && (args.date_from as string) >= today
    ? (args.date_from as string)
    : today;
  const daysRaw = Number(args.days);
  const days = Number.isFinite(daysRaw) ? Math.min(Math.max(Math.trunc(daysRaw), 1), 31) : 14;
  // Поправки запроса называются, а не делаются молча: агент должен знать,
  // что смотрели не то окно, которое он просил.
  const notes = [
    pastFrom ? `Дата ${args.date_from} уже прошла — показываю с сегодняшнего дня по Камчатке.` : '',
    Number.isFinite(daysRaw) && Math.trunc(daysRaw) > 31 ? 'Окно больше 31 дня не смотрю — показываю 31.' : '',
  ].filter(Boolean);
  const to = new Date(Date.parse(from) + (days - 1) * 86400000).toISOString().slice(0, 10);

  try {
    const slots = await fetchAvailabilityForTour(String(tour.id), from, to, createPlannerCache());
    if (slots.length === 0) {
      // «Мест нет» — только когда расписание есть и места разобраны. Тур без
      // календаря (оператор берёт без него) — иной случай: места уточняются у
      // оператора, и create_booking_request отправит ему запрос. До 29.09 оба
      // звучали «реальная занятость из броней», и агент до запроса не доходил.
      const keeps = await tourKeepsSchedule(Number(tour.id));
      if (keeps === false) {
        // Сначала тело: оно дописывает в notes («число людей не распознано»),
        // и раскрыть notes раньше значило бы потерять эту оговорку.
        const body = await onRequestWindow(tour, from, to, args.people, notes);
        return [
          ...notes, ...body,
          `Заявка оператору на странице: ${getPublicBaseUrl()}${tourPath(tour)}?date=<дата>. Данные на ${shortDate(today)} (по Камчатке).`,
        ].join('\n');
      }
      if (keeps === null) {
        return [...notes,
          `Тур "${tour.title}" (ID${tour.id}): свободных дат с ${shortDate(from)} по ${shortDate(to)} не нашёл, а проверить, ведёт ли тур расписание, не смог. `
          + 'Не утверждай, что мест нет, — предложи уточнить у оператора или повторить позже.',
        ].join('\n');
      }
      return [...notes,
        `Тур "${tour.title}" (ID${tour.id}): свободных мест с ${shortDate(from)} по ${shortDate(to)} нет. `
        + 'Это реальная занятость мест — не обещай места на эти даты. Можно проверить другое окно (date_from/days) или другой тур.',
      ].join('\n');
    }
    const SHOWN = 12;
    const people = parsePeople(args.people);
    if (args.people != null && args.people.trim() !== '' && people === null) {
      notes.push(`Число людей «${args.people}» не распознано (нужно 1–30) — итог не посчитан.`);
    }
    const shown = slots.slice(0, SHOWN);
    // Итог — ТЕМ ЖЕ расчётом, что у самой брони (honestTourPrice → reserveBooking):
    // правила цены тура и заполненность даты. Свой расчёт здесь разошёлся бы
    // с суммой брони, и ассистент назвал бы человеку не ту цифру (разбор UCP
    // 03.10: полная стоимость — до подтверждения). Отказ расчёта на дате —
    // «итог не посчитан», а не пропуск строки и не «от».
    const totals = people !== null && tour.base_price != null
      ? await Promise.all(shown.map(async (s) => {
          try {
            const p = await honestTourPrice({
              tourId: tour.id, tourDate: s.date,
              baseUnitPrice: Number(tour.base_price), priceUnit: tour.price_unit,
              participants: people,
              duration: { multi_day_count: tour.multi_day_count ?? null, duration_hours: tour.duration_hours ?? null },
            });
            return p.total;
          } catch (err) {
            // Группа вне ступеней цены — не сбой расчёта: оператор называет цену
            // сам. Отличать это от «итог не посчитан» обязательно: во втором
            // случае можно повторить, в первом — нет (#2246).
            if (err instanceof PriceTierMissError) return 'tier_miss' as const;
            const e = err as { code?: string; message?: string };
            console.error('[tour-availability] итог не посчитан', { tourId: tour.id, date: s.date, sqlstate: e?.code, message: e?.message });
            return null;
          }
        }))
      : null;
    const lines = shown.map((s, i) => {
      // Единица — из тура, а не «р/чел»: у многодневок цена за группу, и
      // агент, прочитавший «140 000 р/чел», называл цену с человека (29.09).
      // Цена на дату может быть переопределена, но единица у неё та же.
      const price = priceFromUnit(s.priceOverride ?? tour.base_price, tour.price_unit);
      const t = totals ? totals[i] : null;
      const total = totals
        ? (t === 'tier_miss'
            ? `; для группы из ${people} чел. цену называет оператор`
            : t != null ? `; итого за ${people} чел.: ${rub(t as number)}` : '; итог не посчитан')
        : '';
      return `- ${shortDate(s.date)} (${s.date}): свободно ${s.remaining}${price ? `, ${price}` : ''}${total}`;
    });
    const more = slots.length > SHOWN
      ? [`…и ещё ${slots.length - SHOWN} дат с местами до ${shortDate(to)} — чтобы увидеть их, сдвиньте date_from.`]
      : [];
    return [
      ...notes,
      `Тур "${tour.title}" (ID${tour.id}) — свободные даты (реальная занятость мест):`,
      ...lines,
      ...more,
      // Ссылка — полным адресом: относительная у внешнего агента никуда не
      // ведёт (проверка MCP 29.09).
      `Заявка оператору на странице: ${getPublicBaseUrl()}${tourPath(tour)}?date=<дата>. Данные на ${shortDate(today)} (по Камчатке).`,
      ...(totals
        ? ['Итог — сумма, которую посчитает заявка на эту дату и число людей (правила цены тура и заполненность даты). Трансферы и услуги из «не входит» в неё не включены.']
        : ['Итоговую сумму за группу на дату даёт этот же инструмент с параметром people.']),
    ].join('\n');
  } catch (err) {
    const e = err as { code?: string; message?: string };
    console.error('[tour-availability] занятость не прочитана', { tourId: tour.id, sqlstate: e?.code, message: e?.message });
    return 'Занятость временно недоступна — не называй даты по памяти, предложи страницу тура.';
  }
}
