'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Compass, ChevronRight, ChevronDown } from 'lucide-react';
import type { PlaceTour, PlaceToursState } from './types';
import { tourPath } from '@/lib/tours/tour-url';
import { OperatorNameLink } from '@/components/operators/OperatorNameLink';
import { priceWithUnitWords } from '@/lib/tours/price-label';
import {
  groupOffersByCompany,
  offerDatesPhrase,
  offersSummary,
  OFFER_ORDER_NOTE_GROUPED_RU,
  type CompanyGroup,
} from '@/lib/tours/offer-order';

interface Props {
  tours: PlaceTour[];
  /** Исход чтения туров (§4.0): «не загрузились» ≠ «туров нет». */
  state: PlaceToursState;
  /** День правила порядка — тот же, по которому сервер расставил туры. */
  day: string;
  placeName: string;
}

/** Сколько туров компании видно сразу; остальные — кнопкой «ещё N». */
const SHOWN_PER_COMPANY = 3;

type Row = PlaceTour & { partnerName: string };

/**
 * Туры к месту — все предложения, сгруппированные по компаниям (слово
 * владельца 29.10, «1в 2б 3 да»).
 *
 * Порядок компаний — правило 1в (lib/tours/offer-order): сначала те, у кого
 * есть свободная дата, по ближайшему выезду; остальные — жребий дня, по
 * одному билету на компанию, сколько бы туров у неё ни было. Правило названо
 * словами под заголовком и кончается фразой «Место в списке не продаётся.»
 * (CLAUDE.md §0).
 *
 * Карточка места — не витрина продажи (§9): брони, цены «от» призывом,
 * фильтров и сортировок здесь нет. Строка тура — ссылка на карточку тура,
 * где цена, даты и бронь.
 *
 * Два списка, тем же правилом, что маршруты (15.10, §0): «к этому месту»
 * вправе сказать только тур, у которого место названо главным
 * (main_place_id), или тур, чей маршрут размечен через место точкой пути.
 * Связь рода unknown («не установлено», §4.1) этого не утверждает.
 */
export default function PlaceTours({ tours, state, day, placeName }: Props) {
  if (state === 'failed') {
    return (
      <section id="tours" className="scroll-mt-20 space-y-3" aria-label={`Туры к месту «${placeName}»`}>
        <ListTitle title="Туры к этому месту" />
        <p className="text-sm text-[var(--warning)]">
          Туры к этому месту не загрузились — это сбой, а не «туров нет». Обновите страницу позже.
        </p>
      </section>
    );
  }
  if (state === 'empty' || tours.length === 0) return null;

  const goesHere = (t: PlaceTour) => t.linkKind === 'waypoint' || t.linkKind === 'main_place';
  const through = tours.filter(goesHere);
  const unmarked = tours.filter((t) => !goesHere(t));

  return (
    <section id="tours" className="scroll-mt-20 space-y-6" aria-label={`Туры к месту «${placeName}»`}>
      {through.length > 0 && <TourList title="Туры к этому месту" tours={through} day={day} withOrderNote />}
      {unmarked.length > 0 && (
        <TourList
          title={through.length > 0 ? 'Ещё туры по маршрутам, связанным с местом' : 'Туры по маршрутам, связанным с местом'}
          note="Проходит ли маршрут тура через само место, у нас не размечено — уточните у оператора."
          tours={unmarked}
          day={day}
          withOrderNote={through.length === 0}
        />
      )}
      <p className="text-xs text-[var(--text-muted)]">
        Туры, которые проходят через несколько мест (облёты, многодневные), здесь не показаны: у них нет одного главного места.
      </p>
    </section>
  );
}

function ListTitle({ title }: { title: string }) {
  return (
    <h2
      className="text-lg font-bold text-[var(--text-primary)] flex items-center gap-2"
      style={{ fontFamily: 'var(--font-playfair)' }}
    >
      <Compass className="w-5 h-5 text-[var(--accent)]" aria-hidden /> {title}
    </h2>
  );
}

function TourList({ title, note, tours, day, withOrderNote }: {
  title: string; note?: string; tours: PlaceTour[]; day: string; withOrderNote: boolean;
}) {
  const rows: Row[] = tours.map((t) => ({ ...t, partnerName: t.operatorName }));
  const groups = groupOffersByCompany(rows, { day });
  return (
    <section className="space-y-3">
      <ListTitle title={title} />
      <p className="text-sm text-[var(--text-secondary)]">{offersSummary(rows.length, groups.length)}</p>
      {withOrderNote && <p className="text-xs text-[var(--text-muted)]">{OFFER_ORDER_NOTE_GROUPED_RU}</p>}
      {note && <p className="text-xs text-[var(--text-muted)]">{note}</p>}
      <div className="space-y-3">
        {groups.map((g) => <CompanyBlock key={g.partnerId} group={g} day={day} />)}
      </div>
    </section>
  );
}

function CompanyBlock({ group, day }: { group: CompanyGroup<Row>; day: string }) {
  const [open, setOpen] = useState(false);
  const first = group.tours[0];
  const hidden = Math.max(0, group.tours.length - SHOWN_PER_COMPANY);
  const shown = open ? group.tours : group.tours.slice(0, SHOWN_PER_COMPANY);
  return (
    <div className="ds-card p-4 space-y-2" data-company={group.partnerId}>
      <p className="text-sm font-semibold text-[var(--text-primary)] flex flex-wrap items-baseline gap-x-2">
        <OperatorNameLink name={group.partnerName} slug={first?.operatorSlug} isPublic={first?.operatorPublic} />
        {first?.partnerVerified === true && (
          <span className="text-xs font-normal text-[var(--success)]">проверен</span>
        )}
      </p>
      <ul className="space-y-1">
        {shown.map((t) => <TourRow key={t.id} t={t} day={day} />)}
      </ul>
      {hidden > 0 && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="min-h-[44px] inline-flex items-center gap-1 text-sm text-[var(--ocean)] hover:text-[var(--accent)] transition-colors duration-200"
        >
          <ChevronDown className={`w-4 h-4 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} aria-hidden />
          {open ? 'свернуть' : `ещё ${hidden}`}
        </button>
      )}
    </div>
  );
}

/** Длительность словами из записанного: дни многодневного, часы, полдня/день. */
function durationWords(t: PlaceTour): string | null {
  if (t.durationType === 'multi_day' && t.multiDayCount && t.multiDayCount > 0) return `${t.multiDayCount} дн.`;
  if (t.durationHours != null && t.durationHours > 0) return `${t.durationHours} ч`;
  if (t.durationType === 'half_day') return 'полдня';
  if (t.durationType === 'day') return '1 день';
  return null;
}

function TourRow({ t, day }: { t: PlaceTour; day: string }) {
  const facts = [
    durationWords(t),
    priceWithUnitWords(t.basePrice, t.priceUnit) ?? 'цена не указана',
    offerDatesPhrase({
      nearestFreeDate: t.nearestFreeDate,
      keepsSchedule: t.keepsSchedule,
      season_start: t.seasonStart,
      season_end: t.seasonEnd,
      duration_type: t.durationType,
      multi_day_count: t.multiDayCount,
      duration_hours: t.durationHours,
    }, day, 'ok'),
  ].filter((x): x is string => Boolean(x));
  return (
    <li className="relative rounded-lg -mx-2 px-2 py-2 flex items-center justify-between gap-3 hover:bg-[var(--bg-hover)] transition-colors duration-200 group">
      <Link href={tourPath(t)} className="absolute inset-0 z-[1] rounded-lg" aria-label={t.title} />
      <div className="flex-1 min-w-0 relative z-[2] pointer-events-none">
        <p className="text-sm font-semibold text-[var(--text-primary)] group-hover:text-[var(--accent)] transition-colors duration-200">
          {t.title}
        </p>
        <p className="mt-0.5 text-xs text-[var(--text-secondary)]">{facts.join(' · ')}</p>
      </div>
      <ChevronRight className="w-4 h-4 flex-shrink-0 text-[var(--text-muted)] relative z-[2] pointer-events-none" aria-hidden />
    </li>
  );
}
