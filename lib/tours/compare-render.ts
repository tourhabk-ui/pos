/**
 * Сравнение туров словами — чистая часть compare_tours (без базы).
 *
 * Правило (§0, слово владельца 29.10): сравнение раскладывает записанные факты
 * рядом и ничего не выбирает. Нет «лучшего», нет баллов и мест, нет
 * «рекомендуем». Туры идут в том порядке, в каком их назвал человек (это его
 * выбор, а не наша витрина), строки — в порядке, в каком он назвал, что ему
 * важно. У строки одна отметка из фиксированного набора: «одинаково» /
 * «отличается», «записано одинаково» / «записано по-разному» (тексты и списки
 * сравниваются как записи, а не по смыслу), «один оператор» / «разные
 * операторы» и третий исход «не сравнить: у IDx …», когда у кого-то значения
 * нет (§4.0). Ноль, «1 день» и «вернём всю сумму» вместо незаписанного не
 * подставляются никогда.
 *
 * Каждую клетку пишет та функция, которая уже называет это поле на карточке
 * тура или в ответах агента (§11): цена — priceFromUnit, итог за группу —
 * groupTotalLabel (тот же расчёт, что get_tour_availability с people),
 * длительность — plateDuration, сложность — difficultyLabel, сезон —
 * requestWindow/windowLabel, даты — offerDatesPhrase, программа — programSteps,
 * подвоз — pickupForCard, продавец — sellerRequisitesLine, условия отмены
 * числами — cancellationTermsLine (только когда записаны оба числа).
 *
 * Сторож: tests/unit/compare-tours.test.ts (граничные данные и мутации),
 * сцена на настоящей базе — tests/integration/public-tour-gate.pg.test.ts.
 */

import { CRITERION_HEADING, type Criterion, type UnknownCriterion } from '@/lib/tours/compare-input';
import { GROUP_TOTAL_EXCLUDES, groupTotalLabel, type GroupTotal } from '@/lib/tours/group-total';
import { priceFromUnit } from '@/lib/tours/price-label';
import { PRICE_UNIT_LABELS, difficultyLabel } from '@/lib/tours/labels';
import { plateDuration } from '@/lib/home/plate-facts';
import { bookingRequestCeiling, isGroupSizeUnlimited, unlimitedGroupSentence } from '@/lib/tours/group-size';
import { longDay, requestWindow, windowLabel } from '@/lib/tours/request-window';
import { offerDatesPhrase } from '@/lib/tours/offer-order';
import { programSteps } from '@/lib/tours/describe';
import { pickupForCard } from '@/lib/tours/pickup';
import { sellerRequisitesLine } from '@/lib/tours/seller-requisites';
import { cancellationTermsLine, refundTermsRecorded } from '@/lib/payments/tour-refund';
import { operatorPagePath } from '@/lib/operators/page-link';
import { tourPath } from '@/lib/tours/tour-url';
import { plural } from '@/lib/home/data-freshness';

/** Факты одного тура из базы — те же поля, что у карточки и get_tour_details. */
export interface CompareTourFacts {
  id: number;
  title: string;
  slug: string | null;
  base_price: number | null;
  price_unit: string | null;
  duration_type: string | null;
  multi_day_count: number | null;
  duration_hours: number | null;
  difficulty: string | null;
  season_start: string | null;
  season_end: string | null;
  max_participants: number | null;
  group_size_unlimited: boolean | null;
  program: unknown;
  included: string[] | null;
  not_included: string[] | null;
  cancellation_policy: string | null;
  cancellation_free_days: number | null;
  cancellation_late_refund_percent: number | null;
  pickup_type: string | null;
  pickup_details: string | null;
  meeting_point: string | null;
  operator_id: string | null;
  operator_name: string | null;
  /** partners.is_verified: null — не записано. */
  operator_verified: boolean | null;
  operator_slug: string | null;
  operator_public: boolean | null;
  operator_legal_name: string | null;
  operator_inn: string | null;
  operator_ogrn: string | null;
  /** Ближайшая дата со свободными местами (nearestFreeDateSql), YYYY-MM-DD. */
  nearest_free_date: string | null;
  /** Ведёт ли тур расписание (keepsScheduleSql); null — не прочитано. */
  keeps_schedule: boolean | null;
}

/** Итог за группу для строки «Цена»: на какую дату и чем кончился расчёт. */
export type GroupPrice =
  | { kind: 'no_price' }
  | { kind: 'schedule_unknown' }
  | { kind: 'no_date' }
  | { kind: 'dates_failed' }
  | { kind: 'on'; date: string; basis: 'slot' | 'request'; total: GroupTotal };

/** Первая дата, где мест хватит на всю группу (nearestSlotFor). */
export type GroupSlot =
  | { state: 'found'; date: string; remaining: number }
  | { state: 'none' }
  | { state: 'failed' };

export interface CompareRow {
  facts: CompareTourFacts;
  /** Итог за группу — только когда названо число людей и спрошена цена. */
  groupPrice?: GroupPrice;
  /** Дата на группу — только когда названо число людей и тур ведёт расписание. */
  groupSlot?: GroupSlot;
}

export interface CompareRenderInput {
  rows: readonly CompareRow[];
  criteria: readonly Criterion[];
  /** Число людей (1–30) или null — не названо. */
  people: number | null;
  /** Сегодня по Камчатке, YYYY-MM-DD. */
  today: string;
  /** Адрес сайта без «/» в конце: ссылки у внешнего агента — полные. */
  base: string;
  /** Строки о входе: кого не нашли, кого взяли по названию, повторы, число людей. */
  notes: readonly string[];
  unknown: readonly UnknownCriterion[];
  defaulted: boolean;
}

/** Клетка: текст и ключ сравнения; null — значения нет, `gap` говорит, чего. */
export interface Cell {
  text: string;
  key: string | null;
  gap?: string;
}

type MarkKind = 'value' | 'record' | 'operator';

/** Отметка строки. Оценок в наборе нет: только совпало, различается или не сравнить. */
export function markOf(cells: ReadonlyArray<{ id: number; cell: Cell }>, kind: MarkKind): string {
  const gaps = cells.filter((c) => c.cell.key === null);
  if (gaps.length > 0) return `не сравнить: ${gaps.map((c) => `у ID${c.id} ${c.cell.gap ?? 'не записано'}`).join('; ')}`;
  const same = new Set(cells.map((c) => c.cell.key)).size === 1;
  if (kind === 'record') return same ? 'записано одинаково' : 'записано по-разному';
  if (kind === 'operator') return same ? 'один оператор' : 'разные операторы';
  return same ? 'одинаково' : 'отличается';
}

const NOT_RECORDED_ASK = 'уточняется у оператора';

function cleanList(items: readonly unknown[] | null | undefined): string[] {
  return Array.isArray(items) ? items.map((i) => String(i).trim()).filter(Boolean) : [];
}

/**
 * Цена тура как в карточке. Единица не записана (или не из словаря) — число
 * есть, а сравнить его не с чем: «за человека» это или «за группу», неизвестно
 * (§4.0), и отметка говорит «не сравнить», а не «за разное» (ревью 29.10).
 */
function basePriceCell(f: CompareTourFacts): Cell {
  const text = priceFromUnit(f.base_price, f.price_unit);
  if (!text) return { text: 'цена не указана — называет оператор, не называй числа', key: null, gap: 'цена не указана' };
  if (!f.price_unit || !PRICE_UNIT_LABELS[f.price_unit]) return { text, key: null, gap: 'не записано, за что назначена цена' };
  return { text, key: `${Number(f.base_price)}|${f.price_unit}` };
}

function groupPriceCell(row: CompareRow, people: number): Cell {
  const f = row.facts;
  const g = row.groupPrice;
  const base = priceFromUnit(f.base_price, f.price_unit);
  const tail = base ? `; цена тура — ${base}` : '';
  if (!g || g.kind === 'no_price' || !base) {
    return { text: 'цена не указана — итог назовёт оператор, не называй числа', key: null, gap: 'цена не указана' };
  }
  if (g.kind === 'schedule_unknown') {
    return { text: `итог не посчитан: не смог проверить, ведёт ли тур расписание${tail}`, key: null, gap: 'итог не посчитан' };
  }
  if (g.kind === 'no_date') {
    return { text: `итог не посчитан: в пределах года нет даты, где мест хватит на ${people} чел.${tail}`, key: null, gap: `нет даты на ${people} чел.` };
  }
  if (g.kind === 'dates_failed') {
    return { text: `итог не посчитан: даты не прочитались${tail}`, key: null, gap: 'итог не посчитан' };
  }
  const label = groupTotalLabel(g.total, people);
  if (g.total.kind !== 'total') {
    return { text: `${label}${tail}`, key: null, gap: g.total.kind === 'tier_miss' ? 'цену называет оператор' : 'итог не посчитан' };
  }
  const why = g.basis === 'slot'
    ? `первая дата, где мест хватит на ${people} чел.`
    : 'первая дата для заявки; расписания нет';
  return { text: `${label} — на ${longDay(g.date)} (${why})${tail}`, key: String(g.total.total) };
}

function durationCell(f: CompareTourFacts): Cell {
  const d = plateDuration({ durationType: f.duration_type, multiDayCount: f.multi_day_count, durationHours: f.duration_hours });
  return d ? { text: d, key: d } : { text: 'не записана', key: null, gap: 'длительность не записана' };
}

/**
 * Группа — путь агентов, а не полоса карточки: «до N» по max_participants
 * бывает заглушкой автора миграции (1176, «технический потолок 15»), и агент
 * пересказал бы её пределом тура (lib/tours/group-size, groupSentenceIfUnlimited).
 * Слово «не ограничена» — только по признаку 1342; потолок одной заявки на
 * сайте назван всегда, когда он есть.
 */
function groupCell(f: CompareTourFacts): Cell {
  if (isGroupSizeUnlimited(f)) {
    return { text: unlimitedGroupSentence(f.max_participants).replace(/\.$/, ''), key: `unlimited|${bookingRequestCeiling(f.max_participants) ?? ''}` };
  }
  const ceiling = bookingRequestCeiling(f.max_participants);
  return {
    text: `предел группы как факт о туре не отмечен${ceiling !== null ? `; одна заявка на сайте — до ${ceiling} чел. (потолок заявки, а не обязательно предел группы)` : ''}`,
    key: null,
    gap: 'предел группы не отмечен',
  };
}

function difficultyCell(f: CompareTourFacts): Cell {
  const d = difficultyLabel(f.difficulty, true);
  return d ? { text: d, key: d } : { text: 'не записана', key: null, gap: 'сложность не записана' };
}

function seasonCell(f: CompareTourFacts, today: string): Cell {
  const w = requestWindow(f, today);
  const recorded = `${f.season_start ?? ''}|${f.season_end ?? ''}`;
  if (w.kind === 'season') return { text: windowLabel(w), key: recorded };
  if (w.why === 'past') {
    return { text: `сезон ${longDay(String(f.season_start).slice(0, 10))} — ${longDay(String(f.season_end).slice(0, 10))} прошёл, следующий не записан`, key: recorded };
  }
  if (w.why === 'too_short') return { text: 'сезон записан короче самого тура — даты уточняет оператор', key: recorded };
  return { text: 'сезон не записан', key: null, gap: 'сезон не записан' };
}

function programCell(f: CompareTourFacts): Cell {
  const steps = programSteps(f.program);
  if (steps.length === 0) return { text: `программа по дням не записана — ${NOT_RECORDED_ASK}`, key: null, gap: 'программа не записана' };
  const titles = steps.map((s) => s.title);
  return {
    text: `записана: ${titles.length} ${plural(titles.length, 'пункт', 'пункта', 'пунктов')} — ${titles.join('; ')} (тексты пунктов — get_tour_details)`,
    key: JSON.stringify(titles),
  };
}

function listCell(items: readonly string[] | null, gap: string): Cell {
  const list = cleanList(items);
  return list.length > 0
    ? { text: list.join('; '), key: JSON.stringify(list) }
    : { text: `не записано — ${NOT_RECORDED_ASK}`, key: null, gap };
}

/**
 * Условия отмены: текст тура дословно и числа, только если записаны оба.
 * Ветку cancellationTermsLine «не записал — вернём всю сумму» здесь не зовём:
 * это обещание платёжного пути, а оплату платформа не принимает
 * (PLATFORM_ACCEPTS_PAYMENTS) — туристу Ведар ничего не возвращает.
 */
function cancellationCell(f: CompareTourFacts): Cell {
  const policy = f.cancellation_policy?.trim() ?? '';
  const terms = { freeDays: f.cancellation_free_days, lateRefundPercent: f.cancellation_late_refund_percent };
  const numbers = refundTermsRecorded(terms);
  const partly = !numbers && (f.cancellation_free_days !== null || f.cancellation_late_refund_percent !== null);
  if (!policy && !numbers) {
    return {
      text: `условия отмены не записаны — ${NOT_RECORDED_ASK}; не называй сроков и процентов${partly ? ' (числами записаны не полностью — не досчитывай)' : ''}`,
      key: null,
      gap: 'условия не записаны',
    };
  }
  const parts = [policy ? `текст тура: «${policy}»` : 'текста условий нет'];
  if (numbers) parts.push(`числами: ${cancellationTermsLine(terms, null)}`);
  else if (partly) parts.push('числами записаны не полностью — не досчитывай');
  return { text: parts.join('; '), key: `${policy}|${numbers ? `${terms.freeDays}|${terms.lateRefundPercent}` : ''}` };
}

function pickupCell(f: CompareTourFacts): Cell {
  const p = pickupForCard(f.pickup_type, f.pickup_details, f.meeting_point);
  if (p) {
    return { text: [p.summary, ...p.lines].join(' '), key: `${f.pickup_type}|${p.lines.join('\n')}` };
  }
  const mp = f.meeting_point?.trim();
  if (mp) return { text: `точка сбора: ${mp}`, key: `meeting|${mp}` };
  return { text: `как туриста доставляют на тур, не записано — ${NOT_RECORDED_ASK}`, key: null, gap: 'не записано, как попасть на тур' };
}

function verifiedWords(v: boolean | null): string {
  if (v === true) return 'проверен платформой';
  if (v === false) return 'отметки «проверен платформой» нет';
  return 'проверка не записана';
}

function operatorCell(f: CompareTourFacts, base: string): Cell {
  const page = operatorPagePath({ slug: f.operator_slug, is_public: f.operator_public });
  return {
    text: `${f.operator_name ?? 'компания не записана'} — ${verifiedWords(f.operator_verified)}; `
      + `исполнитель: ${sellerRequisitesLine(f) ?? 'реквизиты на платформе не записаны'}`
      + (page ? `; страница: ${base}${page}` : ''),
    key: f.operator_id ?? `tour:${f.id}`,
  };
}

function nearestCell(row: CompareRow, people: number | null, today: string): Cell {
  const f = row.facts;
  if (people !== null && f.keeps_schedule === true) {
    const s = row.groupSlot;
    if (s?.state === 'found') return { text: `${longDay(s.date)}, свободно ${s.remaining} — мест хватит на ${people} чел.`, key: s.date };
    if (s?.state === 'none') {
      return { text: `в пределах года нет даты, где мест хватит на ${people} чел.; не обещай места`, key: null, gap: `нет даты на ${people} чел.` };
    }
    return { text: 'даты не загрузились — не говори, что дат нет', key: null, gap: 'даты не загрузились' };
  }
  const phrase = offerDatesPhrase({
    nearestFreeDate: f.nearest_free_date, keepsSchedule: f.keeps_schedule,
    season_start: f.season_start, season_end: f.season_end, duration_type: f.duration_type,
    multi_day_count: f.multi_day_count, duration_hours: f.duration_hours,
  }, today, 'ok');
  if (f.nearest_free_date && f.keeps_schedule !== false) return { text: phrase, key: f.nearest_free_date.slice(0, 10) };
  if (f.keeps_schedule === false) {
    // «Даты не записаны — оператор подтвердит…» уже называет, кто подтверждает.
    const who = phrase.includes('подтвердит') ? '' : ', дату подтверждает оператор';
    return { text: `${phrase}; числа мест нет${who}`, key: null, gap: 'календаря нет — даты по заявке' };
  }
  if (f.keeps_schedule === true) return { text: phrase, key: null, gap: 'на открытые даты мест нет' };
  return { text: phrase, key: null, gap: 'даты не загрузились' };
}

function priceUnitWords(unit: string | null): string {
  return (unit && PRICE_UNIT_LABELS[unit]) || 'за что — не записано';
}

interface Section {
  heading: string;
  mark: string;
  lines: string[];
}

function section(criterion: Criterion, input: CompareRenderInput): Section {
  const { rows, people, today, base } = input;
  const cells = (fn: (r: CompareRow) => Cell) => rows.map((r) => ({ id: r.facts.id, cell: fn(r) }));
  const lines = (cs: ReadonlyArray<{ id: number; cell: Cell }>) => cs.map((c) => `- ID${c.id}: ${c.cell.text}`);
  switch (criterion) {
    case 'price': {
      if (people !== null) {
        const cs = cells((r) => groupPriceCell(r, people));
        return {
          // Чего в итоге нет — общими словами с get_tour_availability; трансфер
          // не назван: у части туров он в цене (ревью 29.10).
          heading: `Цена за ${people} чел. (тем же расчётом, что заявка и get_tour_availability; ${GROUP_TOTAL_EXCLUDES})`,
          mark: markOf(cs, 'value'),
          lines: lines(cs),
        };
      }
      const cs = cells((r) => basePriceCell(r.facts));
      const units = rows.map((r) => r.facts.price_unit);
      const recorded = cs.every((c) => c.cell.key !== null);
      // Цена за человека и за группу — разные величины: «одинаково» и
      // «отличается» между ними неправда. Итог за людей сравним всегда.
      // Незаписанная единица сюда не доходит: её клетка — «не сравнить».
      const mixed = recorded && new Set(units).size > 1;
      return {
        heading: CRITERION_HEADING.price,
        mark: mixed
          ? `не сравнить напрямую: цена назначена за разное — ${rows.map((r) => `ID${r.facts.id} ${priceUnitWords(r.facts.price_unit)}`).join('; ')}; итог за группу — с people`
          : markOf(cs, 'value'),
        lines: lines(cs),
      };
    }
    case 'duration': { const cs = cells((r) => durationCell(r.facts)); return { heading: CRITERION_HEADING.duration, mark: markOf(cs, 'value'), lines: lines(cs) }; }
    case 'group': { const cs = cells((r) => groupCell(r.facts)); return { heading: CRITERION_HEADING.group, mark: markOf(cs, 'value'), lines: lines(cs) }; }
    case 'difficulty': { const cs = cells((r) => difficultyCell(r.facts)); return { heading: CRITERION_HEADING.difficulty, mark: markOf(cs, 'value'), lines: lines(cs) }; }
    case 'season': { const cs = cells((r) => seasonCell(r.facts, today)); return { heading: CRITERION_HEADING.season, mark: markOf(cs, 'value'), lines: lines(cs) }; }
    case 'program': { const cs = cells((r) => programCell(r.facts)); return { heading: CRITERION_HEADING.program, mark: markOf(cs, 'record'), lines: lines(cs) }; }
    case 'included': { const cs = cells((r) => listCell(r.facts.included, 'не записано, что входит')); return { heading: CRITERION_HEADING.included, mark: markOf(cs, 'record'), lines: lines(cs) }; }
    case 'not_included': { const cs = cells((r) => listCell(r.facts.not_included, 'не записано, что не входит')); return { heading: CRITERION_HEADING.not_included, mark: markOf(cs, 'record'), lines: lines(cs) }; }
    case 'cancellation': { const cs = cells((r) => cancellationCell(r.facts)); return { heading: CRITERION_HEADING.cancellation, mark: markOf(cs, 'record'), lines: lines(cs) }; }
    case 'pickup': { const cs = cells((r) => pickupCell(r.facts)); return { heading: CRITERION_HEADING.pickup, mark: markOf(cs, 'record'), lines: lines(cs) }; }
    case 'operator': { const cs = cells((r) => operatorCell(r.facts, base)); return { heading: CRITERION_HEADING.operator, mark: markOf(cs, 'operator'), lines: lines(cs) }; }
    case 'nearest_date': {
      const cs = cells((r) => nearestCell(r, people, today));
      return {
        heading: people !== null ? `Ближайшая дата, где мест хватит на ${people} чел.` : CRITERION_HEADING.nearest_date,
        mark: markOf(cs, 'value'),
        lines: lines(cs),
      };
    }
  }
}

/** Ответ сравнения целиком: шапка с турами по порядку человека, строки критериев, хвост. */
export function renderComparison(input: CompareRenderInput): string {
  const { rows, criteria, base } = input;
  const head = [
    `Сравнение ${rows.length} туров — в том порядке, как их назвали. `
      + 'Это записанные в базе факты рядом, без оценки: какой тур подходит, решает человек.',
    ...rows.map((r, i) => `${i + 1}. ID${r.facts.id} «${r.facts.title}» — ${r.facts.operator_name ?? 'компания не записана'} — ${base}${tourPath(r.facts)}`),
    ...input.notes,
  ];
  const sections = criteria.map((c) => section(c, input)).map((s) => [`${s.heading} — ${s.mark}`, ...s.lines].join('\n'));
  const rest = (Object.keys(CRITERION_HEADING) as Criterion[]).filter((c) => !criteria.includes(c));
  const tail = [
    ...(input.unknown.length > 0
      ? [`Не сравниваю: ${input.unknown.map((u) => `«${u.word}» — ${u.why ?? 'такой строки в сравнении нет'}`).join('; ')}.`]
      : []),
    // «Не названо» — только когда не названо ничего: названное, но не
    // узнанное, перечислено строкой выше (ревью 29.10, §4.0).
    ...(input.defaulted
      ? [input.unknown.length > 0
        ? 'Из названного ни одной строки сравнения не узнано — показан короткий набор строк.'
        : 'Что важно человеку, не названо — показан короткий набор строк.']
      : []),
    ...(rest.length > 0 ? [`Другие строки — по запросу (criteria): ${rest.map((c) => CRITERION_HEADING[c].toLowerCase()).join(', ')}.`] : []),
    'Детали одного тура — get_tour_details, все даты и итог на другую дату — get_tour_availability с people, '
      + 'заявка — create_booking_request с номером тура. Выбирает человек: не выделяй ни один тур и не ставь оценок.',
  ];
  return [head.join('\n'), ...sections, tail.join('\n')].join('\n\n');
}
