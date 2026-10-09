'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Protected } from '@/components/auth/Protected';
import { PdConsentCheckbox } from '@/components/legal/PdConsentCheckbox';
import { GroupEstimateBlock } from '@/components/planner/GroupEstimate';
import { estimateGroup } from '@/lib/planner/estimate';
import { planForLead } from '@/lib/planner/plan-for-lead';
import { dayPriceLine } from '@/lib/planner/day-price';
import type { TripChoices, TripDayPlan, TripParty } from '@/lib/trips/trip-schema';
import { stayLink } from '@/lib/stay/stay-link';
import { tripsLink } from '@/lib/transfers/trips-link';
import {
  ArrowLeft, Calendar, MapPin, Loader, AlertTriangle,
  Footprints, Truck, Anchor, Plane, ChevronDown, ChevronUp,
  Phone, Check, Pencil, PlaneLanding, PlaneTakeoff, BedDouble, Bus,
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

// День и состав — одна форма с сервером (lib/trips/trip-schema): тур, его
// цена и род дня дошли до базы только с 09.10, у старых поездок их нет.
type DayPlan = TripDayPlan;

interface TripDetail {
  id: string;
  title: string;
  arrival_date: string | null;
  departure_date: string | null;
  flight_arrival: string | null;
  flight_departure: string | null;
  places: string[];
  activities: string[];
  days: DayPlan[];
  transport_by_day: Record<string, string>;
  /** Состав и уровень плана; null — поездка сохранена до 09.10. */
  party: TripParty | null;
  /** Выбранные жильё и трансфер, снимок на день сохранения; null — не выбирали. */
  choices?: TripChoices | null;
  created_at: string;
  updated_at: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const ZONE_COLORS: Record<string, string> = {
  avachinsky: 'var(--accent)',
  eastern:    'var(--ocean)',
  northern:   'var(--success)',
  western:    'var(--purple)',
};

const ZONE_LABELS: Record<string, string> = {
  avachinsky: 'Авачинская — вулканы',
  eastern:    'Карагинская — остров',
  northern:   'Тигильская — гейзеры',
  western:    'Мильковская — рыбалка',
};

const TRANSPORT_ICONS: Record<string, React.ElementType> = {
  walking: Footprints, jeep: Truck, boat: Anchor, helicopter: Plane,
};

const TRANSPORT_LABELS: Record<string, string> = {
  walking: 'Пешком', jeep: 'Джип', boat: 'Катер', helicopter: 'Вертолёт',
};

/**
 * Смета поездки — та же формула, что в планировщике (lib/planner/estimate).
 * До 09.10 страница считала свою: ориентир дня плюс цена транспорта из
 * константы (джип 3 000, вертолёт 25 000 ₽), которой нет ни у одного
 * оператора, и без ночей. Считать можно, только если записаны состав группы и
 * род каждого дня; иначе смета не выдумывается, а это говорится словами.
 */
function tripEstimate(trip: TripDetail) {
  if (!trip.party || trip.days.length === 0 || trip.days.some((d) => !d.type)) return null;
  const days = trip.days.map((d) => ({ ...d, type: d.type! }));
  // Выбранное жильё и трансфер (#2304, шаг 3б) — той же сметой, что в планировщике.
  return estimateGroup(days, { ...trip.party, arrivalDate: trip.arrival_date?.slice(0, 10) ?? null }, trip.choices ?? undefined);
}

function tripPlanForLead(trip: TripDetail) {
  if (!trip.party || trip.days.length === 0 || trip.days.some((d) => !d.type)) return null;
  const days = trip.days.map((d) => ({ ...d, type: d.type! }));
  return planForLead(days, { ...trip.party, arrivalDate: trip.arrival_date?.slice(0, 10) ?? null }, trip.choices ?? undefined);
}

const rub = (n: number) => `${Math.round(n).toLocaleString('ru-RU')} ₽`;
const shortDay = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/**
 * Жильё и трансфер, взятые в план (#2304, шаг 3б). Цена — снимок на день
 * сохранения: свободные номера и цены у хозяина меняются, и экран так и
 * говорит, а ссылка ведёт на объект и витрину с датами плана.
 */
function ChoicesBlock({ choices, party }: { choices: TripChoices; party: TripParty | null }) {
  if (choices.stays.length === 0 && choices.transfers.length === 0) return null;
  return (
    <div className="ds-card p-5 space-y-3" data-testid="trip-choices">
      <div>
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">Жильё и трансфер в плане</h2>
        <p className="text-xs text-[var(--text-muted)] mt-0.5">Цены — на день сохранения поездки; свободные номера и места проверьте по ссылке.</p>
      </div>
      {choices.stays.map((st) => (
        <div key={`${st.zone}-${st.checkIn}`} className="flex items-start gap-2">
          <BedDouble className="w-4 h-4 mt-0.5 shrink-0 text-[var(--ocean)]" />
          <div className="min-w-0 text-sm">
            <Link className="font-medium" href={party
              ? stayLink(st.accommodationId, {
                checkIn: st.checkIn, checkOut: st.checkOut, adults: party.adults, children: party.children.length,
                ...(st.price?.kind === 'priced' ? { roomId: st.price.roomId, rooms: st.price.rooms } : {}),
              })
              : `/accommodations/${st.accommodationId}`}>
              {st.name}
            </Link>
            <p className="text-xs text-[var(--text-secondary)]">
              {shortDay(st.checkIn)} — {shortDay(st.checkOut)}
              {' · '}
              {st.price?.kind === 'priced'
                ? `${rub(st.price.total)} на группу, номеров: ${st.price.rooms} «${st.price.roomName}»`
                : st.price ? 'номера и цену подберёт хозяин' : 'цену назовёт хозяин'}
            </p>
          </div>
        </div>
      ))}
      {choices.transfers.map((t) => (
        <div key={t.tripId} className="flex items-start gap-2">
          <Bus className="w-4 h-4 mt-0.5 shrink-0 text-[var(--ocean)]" />
          <div className="min-w-0 text-sm">
            <Link className="font-medium" href={tripsLink({ from: t.date, to: t.date, seats: t.seats, tripId: t.tripId })}>
              {t.from} — {t.to}
            </Link>
            <p className="text-xs text-[var(--text-secondary)]">
              {shortDay(t.date)} · {t.carrier} · мест: {t.seats}
              {' · '}
              {t.pricePerSeat === null ? 'цену назовёт перевозчик' : `${rub(t.pricePerSeat)} за место`}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

function fmtDate(d: string | null): string {
  if (!d) return '';
  return new Date(d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

// ─── Main component ───────────────────────────────────────────────────────────

export function TripDetailClient({ tripId }: { tripId: string }) {
  const [trip, setTrip] = useState<TripDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Contact form
  const [showContact, setShowContact] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [formError, setFormError] = useState('');
  const [pdConsent, setPdConsent] = useState(false);
  const [showDays, setShowDays] = useState(true);

  useEffect(() => {
    fetch(`/api/trips/${tripId}`)
      .then(r => r.json())
      .then(d => {
        if (d.success) setTrip(d.data);
        else setError(d.error ?? 'Маршрут не найден');
      })
      .catch(() => setError('Нет соединения'))
      .finally(() => setLoading(false));
  }, [tripId]);

  async function submitLead() {
    if (!name.trim() || !phone.trim()) {
      setFormError('Введите имя и телефон');
      return;
    }
    if (!pdConsent) {
      setFormError('Необходимо согласие на обработку персональных данных');
      return;
    }
    setFormError('');
    setSubmitting(true);
    try {
      const res = await fetch('/api/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          phone: phone.trim(),
          comment: trip ? `Маршрут: ${trip.title} (${trip.days.length} дн.)` : undefined,
          // `source_data`, как в схеме /api/leads. Здесь стояло `sourceData`:
          // Zod отбрасывает незнакомый ключ, и до оператора доходил один
          // комментарий — без дат, рейсов и мест поездки.
          source_data: {
            source: 'saved_trip',
            trip_id: tripId,
            trip_title: trip?.title,
            arrival: trip?.arrival_date,
            departure: trip?.departure_date,
            flight_arrival: trip?.flight_arrival ?? undefined,
            flight_departure: trip?.flight_departure ?? undefined,
            places: trip?.places,
            activities: trip?.activities,
            // План целиком (#2304, шаг 2) — та же сводка, что из планировщика.
            ...(trip && tripPlanForLead(trip) ? { plan: tripPlanForLead(trip) } : {}),
          },
          pd_consent: true,
        }),
      });
      const data = await res.json();
      if (data.success) setDone(true);
      else setFormError(data.error ?? 'Ошибка');
    } catch {
      setFormError('Нет соединения');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return (
    <div className="flex items-center justify-center py-20 gap-2 text-[var(--text-muted)]">
      <Loader className="w-5 h-5 animate-spin" />
      <span className="text-sm">Загружаем маршрут...</span>
    </div>
  );

  if (error || !trip) return (
    <div className="ds-page max-w-2xl mx-auto">
      <div className="flex items-center gap-2 p-4 bg-[var(--danger)]/10 border border-[var(--danger)]/30 rounded-lg">
        <AlertTriangle className="w-4 h-4 text-[var(--danger)] shrink-0" />
        <p className="text-sm text-[var(--danger)]">{error || 'Маршрут не найден'}</p>
      </div>
      <Link href="/hub/tourist/trips" className="mt-4 inline-flex items-center gap-2 text-sm text-[var(--ocean)] hover:underline">
        <ArrowLeft className="w-4 h-4" /> Все маршруты
      </Link>
    </div>
  );

  const estimate = tripEstimate(trip);

  return (
    <Protected roles={['tourist', 'admin']}>
      <div className="ds-page max-w-2xl mx-auto space-y-6">

        {/* Back */}
        <Link href="/hub/tourist/trips"
          className="inline-flex items-center gap-2 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
          <ArrowLeft className="w-4 h-4" /> Все маршруты
        </Link>

        {/* Header */}
        <div className="ds-card p-5 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <h1 className="font-playfair text-2xl font-bold text-[var(--text-primary)] leading-tight">
              {trip.title}
            </h1>
            <Link href="/planner"
              className="ds-btn ds-btn-secondary flex items-center gap-2 px-3 py-2 text-xs font-medium shrink-0">
              <Pencil className="w-3.5 h-3.5" />
              {/* Планер не открывает сохранённый маршрут по id — «Изменить»
                  обещало правку, а давало пустой планер и новую копию. */}
              Собрать заново
            </Link>
          </div>

          <div className="flex flex-wrap gap-3 text-sm text-[var(--text-secondary)]">
            {trip.arrival_date && (
              <span className="flex items-center gap-1.5">
                <Calendar className="w-4 h-4" />
                {fmtDate(trip.arrival_date)}
                {trip.departure_date && <> — {fmtDate(trip.departure_date)}</>}
              </span>
            )}
            {trip.days.length > 0 && (
              <span className="flex items-center gap-1.5">
                <MapPin className="w-4 h-4" />
                {trip.days.length} {trip.days.length === 1 ? 'день' : trip.days.length < 5 ? 'дня' : 'дней'}
              </span>
            )}
            {trip.flight_arrival && (
              <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-[var(--ocean)]/10 text-[var(--ocean)] text-xs font-semibold">
                <Plane className="w-3.5 h-3.5" />
                {trip.flight_arrival}
              </span>
            )}
            {trip.flight_departure && (
              <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-[var(--ocean)]/10 text-[var(--ocean)] text-xs font-semibold">
                <Plane className="w-3.5 h-3.5 rotate-180" />
                {trip.flight_departure}
              </span>
            )}
          </div>

          {trip.days.length > 0 && (estimate ? (
            <GroupEstimateBlock estimate={estimate} />
          ) : (
            <p className="pt-2 border-t border-[var(--border)] text-xs text-[var(--text-secondary)]" data-testid="trip-no-estimate">
              Смету не считаем: поездка сохранена до того, как в ней стал записываться состав группы.
              Соберите её заново в планировщике — смета на группу появится.
            </p>
          ))}
        </div>

        {trip.choices && <ChoicesBlock choices={trip.choices} party={trip.party} />}

        {/* Day plan */}
        {trip.days.length > 0 && (
          <div className="ds-card overflow-hidden">
            <button
              onClick={() => setShowDays(v => !v)}
              className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-[var(--bg-hover)] transition-colors">
              <span className="text-sm font-semibold text-[var(--text-primary)]">
                План по дням ({trip.days.length})
              </span>
              {showDays ? <ChevronUp className="w-4 h-4 text-[var(--text-muted)]" /> : <ChevronDown className="w-4 h-4 text-[var(--text-muted)]" />}
            </button>

            {showDays && (
              <div className="divide-y divide-[var(--border)]">
                {trip.days.map((d, idx) => {
                  const transport = trip.transport_by_day[String(d.day)] ?? d.defaultTransport;
                  const TransIcon = TRANSPORT_ICONS[transport] ?? Footprints;
                  const flightBadge = idx === 0 && trip.flight_arrival ? trip.flight_arrival
                    : idx === trip.days.length - 1 && trip.flight_departure ? trip.flight_departure
                    : null;
                  return (
                    <div key={d.day} className="flex items-center gap-3 px-5 py-3">
                      <div className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold text-white shrink-0"
                        style={{ background: ZONE_COLORS[d.zone] ?? 'var(--accent)' }}>
                        {idx + 1}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <p className="text-sm font-medium text-[var(--text-primary)] truncate">{d.title}</p>
                          {flightBadge && (
                            <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-[var(--ocean)]/15 text-[var(--ocean)] text-[9px] font-bold shrink-0 whitespace-nowrap">
                              <Plane className="w-2.5 h-2.5" />
                              {flightBadge}
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-[var(--text-muted)]">
                          {ZONE_LABELS[d.zone] ?? d.zone}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="flex items-center gap-1 text-[11px] text-[var(--text-muted)]">
                          <TransIcon className="w-3 h-3" />
                          {TRANSPORT_LABELS[transport] ?? transport}
                        </span>
                        {/* Цена с единицей, как в планировщике (lib/planner/day-price):
                            без выдуманной надбавки за транспорт. */}
                        {dayPriceLine(d) && (
                          <span className="text-xs font-medium text-[var(--accent)]">{dayPriceLine(d)}</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* CTA */}
        {done ? (
          <div className="ds-card p-6 text-center space-y-2">
            <div className="w-10 h-10 rounded-full bg-[var(--success)]/15 flex items-center justify-center mx-auto">
              <Check className="w-5 h-5 text-[var(--success)]" />
            </div>
            <p className="font-semibold text-[var(--text-primary)]">Заявка отправлена</p>
            <p className="text-sm text-[var(--text-secondary)]">Свяжемся с вами в ближайшее время.</p>
          </div>
        ) : !showContact ? (
          <button onClick={() => setShowContact(true)}
            className="w-full ds-btn ds-btn-primary py-3 font-semibold text-base">
            Запросить подробное предложение
          </button>
        ) : (
          <div className="ds-card p-5 space-y-3">
            <p className="text-sm font-bold uppercase tracking-widest text-[var(--text-muted)]">Контакты</p>
            <input type="text" value={name} onChange={e => setName(e.target.value)}
              placeholder="Ваше имя" className="ds-input w-full" />
            <input type="tel" value={phone} onChange={e => setPhone(e.target.value)}
              placeholder="+7 900 000-00-00" className="ds-input w-full" />
            {formError && (
              <div className="flex items-center gap-2 p-2 bg-[var(--danger)]/10 rounded">
                <AlertTriangle className="w-3.5 h-3.5 text-[var(--danger)] shrink-0" />
                <p className="text-xs text-[var(--danger)]">{formError}</p>
              </div>
            )}
            <PdConsentCheckbox checked={pdConsent} onChange={setPdConsent} id="pd-consent-trip" />
            <button onClick={submitLead} disabled={submitting || !pdConsent}
              className="w-full ds-btn ds-btn-primary py-2.5 font-semibold disabled:opacity-50 flex items-center justify-center gap-2">
              {submitting ? <><Loader className="w-4 h-4 animate-spin" />Отправляем...</> : <>
                <Phone className="w-4 h-4" />Отправить заявку
              </>}
            </button>
          </div>
        )}
      </div>
    </Protected>
  );
}
