/**
 * compare_tours — 2–4 конкретных тура рядом по тому, что важно человеку
 * (слово владельца 29.10: «делай» на «сравнение 2–4 туров … только факты из
 * базы»). Один мозг — два протокола: инструмент живёт в реестре Кузьмича и
 * через него же отдаётся публичному MCP и A2A.
 *
 * Это не подбор и не новый движок поиска (CLAUDE.md §4): туры называет
 * человек или агент, каждый находится тем же резолвером, что у
 * get_tour_details (resolveTourChoice), и тем же шлюзом витрины. Неоднозначное
 * имя, имя продавца или совпала часть слов — сравнения нет, в ответе номера:
 * частичную таблицу агент пересказал бы как сравнение, а выбрать тур за
 * человека инструмент не вправе (как create_booking_request). Тур не на
 * витрине (черновик, скрыт, снят) не сравнивается и называется теми же
 * словами, что у соседей, — «не найден среди активных»: «это черновик»
 * раскрыло бы анониму, что он существует.
 *
 * Факты читаются одним запросом с шлюзом, итог за людей считает
 * groupTotalOn (тот же расчёт, что у get_tour_availability с people и у самой
 * брони), дату на группу — nearestSlotFor (тот же движок, что гейт брони).
 * Ничего не пишет; ПД в ответе нет. Текст собирает чистая
 * lib/tours/compare-render.
 */

import { pool } from '@/lib/db-pool';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { nearestFreeDateSql } from '@/lib/tours/nearest-free-date';
import { keepsScheduleSql } from '@/lib/tours/schedule';
import { kamchatkaToday } from '@/lib/seat-requests/core';
import { getPublicBaseUrl } from '@/lib/config';
import { requestWindow } from '@/lib/tours/request-window';
import {
  COMPARE_MIN_TOURS, parseCriteria, splitTourList, tourCountRefusal, tourIdOf,
} from '@/lib/tours/compare-input';
import {
  renderComparison, type CompareRow, type CompareTourFacts, type GroupPrice, type GroupSlot,
} from '@/lib/tours/compare-render';
import {
  candidateLines, choiceListLines, choiceListReason, groupTotalOn, nearestSlotFor, parsePeople,
  resolveTourChoice, type ResolvedTour, type TourCandidate, type TourChoice,
} from '@/lib/kuzmich/tour-availability-tool';

export interface CompareToursArgs {
  tours?: string;
  criteria?: string;
  people?: string;
  /**
   * Дата, которую агент передал по образцу get_tour_availability. Сравнение
   * её не принимает — итог считается на дату, названную в каждой строке, — и
   * говорит это в ответе, а не теряет молча (ревью 29.10).
   */
  date?: string;
}

const notFound = (ref: string) => `Тур по запросу "${ref}" не найден среди активных — в сравнение не взят.`;

/** Запрос фактов: те же поля, что у карточки и get_tour_details, и шлюз витрины. */
const FACTS_SQL = `SELECT ot.id, ot.title, ot.slug, ot.base_price::float8 AS base_price, ot.price_unit,
       ot.duration_type, ot.multi_day_count, ot.duration_hours::float8 AS duration_hours,
       ot.difficulty, ot.season_start::text AS season_start, ot.season_end::text AS season_end,
       ot.max_participants, ot.group_size_unlimited, ot.program, ot.included, ot.not_included,
       ot.cancellation_policy, ot.cancellation_free_days, ot.cancellation_late_refund_percent,
       ot.pickup_type, ot.pickup_details, ot.meeting_point, ot.operator_id::text AS operator_id,
       p.name AS operator_name, p.is_verified AS operator_verified, p.slug AS operator_slug, p.is_public AS operator_public,
       NULLIF(btrim(p.legal_info->>'companyName'), '') AS operator_legal_name,
       NULLIF(btrim(p.legal_info->>'inn'), '') AS operator_inn,
       NULLIF(btrim(p.legal_info->>'ogrn'), '') AS operator_ogrn,
       ${nearestFreeDateSql('ot')} AS nearest_free_date,
       ${keepsScheduleSql('ot.id')} AS keeps_schedule
  FROM operator_tours ot
  LEFT JOIN partners p ON p.id = ot.operator_id
 WHERE ot.id = ANY($1::bigint[]) AND ${publicTourSql('ot')}`;

/** Факты туров по номерам; отказ базы — исключение со строкой в логе (§4.0). */
async function loadFacts(ids: readonly number[]): Promise<Map<number, CompareTourFacts>> {
  try {
    const { rows } = await pool.query<CompareTourFacts>(FACTS_SQL, [ids]);
    return new Map(rows.map((r) => [Number(r.id), { ...r, id: Number(r.id) }]));
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    console.error('[compare-tours] факты туров не прочитаны:', typeof code === 'string' ? code : '', err instanceof Error ? err.message : String(err));
    throw err;
  }
}

function asResolved(f: CompareTourFacts): ResolvedTour {
  return {
    id: f.id, title: f.title, operator_id: f.operator_id, slug: f.slug,
    base_price: f.base_price, price_unit: f.price_unit,
    multi_day_count: f.multi_day_count, duration_hours: f.duration_hours, duration_type: f.duration_type,
    season_start: f.season_start, season_end: f.season_end,
  };
}

/**
 * Итог за группу и дата на неё. Дата называется в ответе: сумма от неё
 * зависит (заполненность, сезонные правила). Тур с расписанием — первая дата,
 * где мест хватит на всех; без расписания — первая дата окна заявки (как
 * первая строка get_tour_availability с people).
 */
async function groupExtras(f: CompareTourFacts, people: number, today: string, wantPrice: boolean, wantSlot: boolean): Promise<Pick<CompareRow, 'groupPrice' | 'groupSlot'>> {
  const slot: GroupSlot | undefined = f.keeps_schedule === true && (wantPrice || wantSlot)
    ? await nearestSlotFor(f.id, people, today)
    : undefined;
  if (!wantPrice) return { groupSlot: slot };
  let groupPrice: GroupPrice;
  if (f.base_price == null) groupPrice = { kind: 'no_price' };
  else if (f.keeps_schedule === null) groupPrice = { kind: 'schedule_unknown' };
  else if (f.keeps_schedule === true) {
    if (slot?.state === 'found') {
      groupPrice = { kind: 'on', date: slot.date, basis: 'slot', total: await groupTotalOn(asResolved(f), slot.date, people) };
    } else groupPrice = slot?.state === 'none' ? { kind: 'no_date' } : { kind: 'dates_failed' };
  } else {
    const w = requestWindow(f, today);
    const date = w.kind === 'season' ? w.from : today;
    groupPrice = { kind: 'on', date, basis: 'request', total: await groupTotalOn(asResolved(f), date, people) };
  }
  return { groupPrice, groupSlot: slot };
}

/** Отказ «сравнение не собрано» по одной позиции — слова create_booking_request. */
function choiceBlock(ref: string, choice: Exclude<TourChoice, { kind: 'one' } | { kind: 'none' }>): string[] {
  if (choice.kind === 'ambiguous') {
    return [
      `По запросу «${ref}» подходят туры разных компаний — сравнение не собрано. Повторите compare_tours с номерами туров (поле tours):`,
      ...candidateLines(choice.candidates),
      'Порядок списка — правило платформы, а не рекомендация.',
    ];
  }
  return [
    `По запросу «${ref}» ${choiceListReason(choice)} — сравнение не собрано. Повторите compare_tours с номерами туров (поле tours).`,
    ...choiceListLines(ref, choice),
  ];
}

export async function compareToursForKuzmich(args: CompareToursArgs): Promise<string> {
  // Отказ по числу туров — те же слова, что у схемы инструмента.
  const refusal = tourCountRefusal(args.tours ?? '');
  if (refusal) return `Сравнение не собрано: ${refusal}.`;
  const refs = splitTourList(args.tours ?? '');

  const criteria = parseCriteria(args.criteria);
  const people = parsePeople(args.people);
  const notes: string[] = [];
  if (args.people != null && args.people.trim() !== '' && people === null) {
    notes.push(`Число людей «${args.people}» не распознано (нужно 1–30) — итог за группу не посчитан, цена — как в карточке.`);
  }
  const askedDate = args.date?.trim();
  if (askedDate) {
    notes.push(`Дату «${askedDate}» сравнение не принимает: итог и даты ниже — на даты, названные у каждого тура. `
      + `Итог на «${askedDate}» — get_tour_availability с date_from и people по каждому туру.`);
  }

  // Резолв по одному, в порядке человека: не больше четырёх, у каждого до
  // трёх коротких запросов. Отказ базы — исключение резолвера (уже в логе).
  const blocks: string[][] = [];
  const picked: Array<{ ref: string; tour: TourCandidate }> = [];
  for (const ref of refs) {
    const choice = await resolveTourChoice(ref);
    if (choice.kind === 'none') notes.push(notFound(ref));
    else if (choice.kind === 'one') picked.push({ ref, tour: choice.tour });
    else blocks.push(choiceBlock(ref, choice));
  }
  if (blocks.length > 0) {
    return [
      ...blocks.flat(),
      ...notes,
      'Спросите человека, какой тур и какая компания ему нужны; не выбирайте за него.',
    ].join('\n');
  }

  // Один тур, названный дважды (номером и названием), — в сравнении один раз.
  const order: Array<{ ref: string; id: number }> = [];
  for (const p of picked) {
    const first = order.find((o) => o.id === p.tour.id);
    if (first) {
      notes.push(`«${p.ref}» и «${first.ref}» — один и тот же тур ID${p.tour.id}; в сравнении он один раз.`);
      continue;
    }
    order.push({ ref: p.ref, id: p.tour.id });
    // Взятый по названию тур назван: у одной компании с этим названием их бывает несколько.
    if (tourIdOf(p.ref) === null) {
      notes.push(`По запросу «${p.ref}» взят ID${p.tour.id} «${p.tour.title}» — ${p.tour.operator_name ?? 'компания не записана'}.`);
    }
  }

  const facts = order.length > 0 ? await loadFacts(order.map((o) => o.id)) : new Map<number, CompareTourFacts>();
  const kept = order.filter((o) => {
    if (facts.has(o.id)) return true;
    notes.push(notFound(o.ref));
    return false;
  });
  if (kept.length < COMPARE_MIN_TOURS) {
    return [
      kept.length === 1
        ? `Сравнивать нечего: на витрине из названных остался один тур (ID${kept[0].id}). Назовите ещё один номер — get_tours, get_place_info.`
        : 'Сравнивать нечего: ни один из названных туров не найден на витрине. Номера туров — get_tours, get_place_info.',
      ...notes,
    ].join('\n');
  }

  const today = kamchatkaToday();
  const wantPrice = criteria.keys.includes('price');
  const wantSlot = criteria.keys.includes('nearest_date');
  const rows: CompareRow[] = await Promise.all(kept.map(async (o) => {
    const f = facts.get(o.id) as CompareTourFacts;
    if (people === null) return { facts: f };
    return { facts: f, ...(await groupExtras(f, people, today, wantPrice, wantSlot)) };
  }));

  return renderComparison({
    rows, criteria: criteria.keys, people, today, base: getPublicBaseUrl(),
    notes, unknown: criteria.unknown, defaulted: criteria.defaulted,
  });
}
