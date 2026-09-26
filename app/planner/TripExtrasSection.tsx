'use client';

/**
 * «Что ещё нужно» на экране результата планера (решение владельца 26.09):
 * настоящее жильё на ночи плана, поездки перевозчиков на даты поездки и
 * честный ответ про аренду машин.
 *
 * Здесь только то, что лежит на платформе. Оценка стоимости проживания и
 * транспорта — выше, в «Оценке стоимости», и подписана оценкой: одно не
 * выдаётся за другое (§4.0).
 *
 * У каждого ответа три исхода: варианты; «на платформе нет» со ссылкой на
 * каталог; «не смогли проверить» — это не «нет», и экран так и говорит.
 */

import Link from 'next/link';
import { BedDouble, Bus, Car, Star, ArrowRight, AlertTriangle, BadgeCheck } from 'lucide-react';
import { ACCOMMODATION_TYPE_LABELS } from '@/lib/stay/accommodation-types';
import type { TripExtrasData, LodgingStayView, TransferOptionView } from './planner-types';

export type ExtrasLoad =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; data: TripExtrasData };

const TYPE_LABELS: Record<string, string> = ACCOMMODATION_TYPE_LABELS;

const KIND_LABEL: Record<string, string> = {
  jeep: 'джип', vahtovka: 'вахтовка', minibus: 'микроавтобус', other: 'транспорт',
};

function fmtRub(n: number): string {
  return `${new Intl.NumberFormat('ru-RU').format(n)} ₽`;
}

function fmtDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function nightsRu(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} ночь`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} ночи`;
  return `${n} ночей`;
}

function Unavailable({ what }: { what: string }) {
  return (
    <p className="flex items-start gap-2 text-sm text-[var(--warning)]">
      <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
      <span>Не смогли проверить {what} — сбой на нашей стороне. Это не значит, что вариантов нет: попробуйте позже.</span>
    </p>
  );
}

function CatalogueLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href}
      className="inline-flex items-center gap-1.5 min-h-[44px] text-sm font-medium text-[var(--ocean)] hover:underline underline-offset-2">
      {children}<ArrowRight className="w-4 h-4" />
    </Link>
  );
}

function StayBlock({ stay }: { stay: LodgingStayView }) {
  return (
    <div className="space-y-2" data-testid="lodging-stay">
      <p className="text-sm text-[var(--text-primary)]">
        <span className="font-semibold">{stay.zoneName}</span>
        <span className="text-[var(--text-secondary)]"> · {nightsRu(stay.nights)}, {fmtDay(stay.checkIn)} — {fmtDay(stay.checkOut)}</span>
      </p>
      {stay.result.state === 'ok' && (
        <ul className="space-y-1.5">
          {stay.result.items.map((o) => (
            <li key={o.id}>
              <Link href={`/accommodations/${o.id}`}
                className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg-card)] px-3 py-2.5 min-h-[44px] transition-colors duration-200 hover:border-[var(--accent)] motion-reduce:transition-none">
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-sm font-medium text-[var(--text-primary)]">
                    <span className="truncate">{o.name}</span>
                    {o.isVerified && <BadgeCheck className="w-4 h-4 shrink-0 text-[var(--success)]" aria-label="Проверено платформой" />}
                  </span>
                  <span className="block text-xs text-[var(--text-secondary)] mt-0.5">
                    {TYPE_LABELS[o.type] ?? o.type}
                    {o.rating !== null && (
                      <>
                        {' · '}
                        <Star className="inline w-3 h-3 -mt-0.5 text-[var(--warning)]" />{' '}
                        {o.rating.toFixed(1)} ({o.reviewCount})
                      </>
                    )}
                  </span>
                </span>
                <span className="shrink-0 text-right text-sm text-[var(--text-primary)]">
                  {o.priceFrom === null
                    ? <span className="text-xs text-[var(--text-muted)]">цена не указана</span>
                    : <>от {fmtRub(o.priceFrom)}<span className="block text-[10px] text-[var(--text-muted)]">за ночь</span></>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {stay.result.state === 'empty' && (
        <div>
          <p className="text-sm text-[var(--text-secondary)]">
            На ваши даты свободного жилья в этой зоне на платформе нет.
          </p>
          <CatalogueLink href="/accommodations">Весь каталог жилья</CatalogueLink>
        </div>
      )}
      {stay.result.state === 'unavailable' && <Unavailable what="жильё в этой зоне" />}
    </div>
  );
}

function TransferRow({ t, arrival, departure }: { t: TransferOptionView; arrival: string; departure: string }) {
  const tag = t.tripDate === arrival ? 'в день прилёта' : t.tripDate === departure ? 'в день отъезда' : null;
  return (
    <li className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] px-3 py-2.5">
      <p className="text-sm font-medium text-[var(--text-primary)]">{t.fromText} — {t.toText}</p>
      <p className="text-xs text-[var(--text-secondary)] mt-0.5">
        {fmtDay(t.tripDate)}{t.departureNote ? `, ${t.departureNote}` : ''}
        {tag && <span className="text-[var(--ocean)]"> · {tag}</span>}
      </p>
      <p className="text-xs text-[var(--text-secondary)] mt-0.5">
        {KIND_LABEL[t.vehicleKind] ?? t.vehicleKind} «{t.vehicleTitle}» · {t.partnerName}
        {' · '}свободно {t.seatsFree} из {t.seatsTotal}
        {' · '}{t.pricePerSeat === null ? 'цена за место не указана' : `${fmtRub(t.pricePerSeat)} за место`}
      </p>
    </li>
  );
}

export function TripExtrasSection({ load, arrival, departure }: {
  load: ExtrasLoad;
  arrival: string;
  departure: string;
}) {
  return (
    <section className="space-y-4 rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4" aria-label="Что ещё нужно" data-testid="trip-extras">
      <div>
        <h2 className="font-playfair text-xl font-bold text-[var(--text-primary)]">Что ещё нужно</h2>
        <p className="text-xs text-[var(--text-secondary)] mt-1">
          Настоящие предложения на платформе на ваши даты — не оценка.
        </p>
      </div>

      {load.status === 'loading' && (
        <div className="space-y-2" aria-busy="true">
          <div className="ds-skeleton h-12 rounded-lg" />
          <div className="ds-skeleton h-12 rounded-lg" />
        </div>
      )}

      {load.status === 'error' && (
        <Unavailable what="жильё и трансферы" />
      )}

      {load.status === 'ready' && (
        <>
          {load.data.lodging && (
            <div className="space-y-3" data-testid="extras-lodging">
              <p className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
                <BedDouble className="w-4 h-4 text-[var(--ocean)]" />Жильё
              </p>
              {load.data.lodging.state === 'no_dates' && (
                <p className="text-sm text-[var(--text-secondary)]">Укажите даты прилёта и отъезда — без них свободное жильё не проверить.</p>
              )}
              {load.data.lodging.state === 'checked' && (
                <>
                  {load.data.lodging.stays.length === 0 && (
                    <p className="text-sm text-[var(--text-secondary)]">
                      {load.data.lodging.nightsInTours > 0
                        ? 'Все ночи плана — в турах с проживанием, отдельное жильё не нужно.'
                        : 'В плане нет ночей — жильё не нужно.'}
                    </p>
                  )}
                  {load.data.lodging.stays.map((s) => <StayBlock key={`${s.zone}-${s.checkIn}`} stay={s} />)}
                  {load.data.lodging.stays.length > 0 && load.data.lodging.nightsInTours > 0 && (
                    <p className="text-xs text-[var(--text-muted)]">
                      Ещё {nightsRu(load.data.lodging.nightsInTours)} — в турах с проживанием, на них жильё не ищем.
                    </p>
                  )}
                  {load.data.lodging.unzonedCount !== null && load.data.lodging.unzonedCount > 0 && (
                    <p className="text-xs text-[var(--text-muted)]">
                      Ещё объектов без разметки зоны: {load.data.lodging.unzonedCount}. Планер их не предлагает — они есть в каталоге.
                    </p>
                  )}
                </>
              )}
            </div>
          )}

          {load.data.transfer && (
            <div className="space-y-2" data-testid="extras-transfer">
              <p className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
                <Bus className="w-4 h-4 text-[var(--ocean)]" />Трансфер
              </p>
              {load.data.transfer.state === 'no_dates' && (
                <p className="text-sm text-[var(--text-secondary)]">Укажите даты прилёта и отъезда — без них поездки перевозчиков не проверить.</p>
              )}
              {load.data.transfer.state === 'window_too_long' && (
                <div>
                  <p className="text-sm text-[var(--text-secondary)]">
                    Поездка длиннее {load.data.transfer.maxDays} дней — поездки перевозчиков смотрите на витрине по датам.
                  </p>
                  <CatalogueLink href="/transfers">Поездки перевозчиков</CatalogueLink>
                </div>
              )}
              {load.data.transfer.state === 'ok' && (
                <>
                  <p className="text-xs text-[var(--text-secondary)]">
                    С {fmtDay(load.data.transfer.window.from)} по {fmtDay(load.data.transfer.window.to)}, места на всю группу ({load.data.transfer.window.seats} чел.):
                  </p>
                  <ul className="space-y-1.5">
                    {load.data.transfer.items.map((t) => (
                      <TransferRow key={t.id} t={t} arrival={arrival} departure={departure} />
                    ))}
                  </ul>
                  <CatalogueLink href="/transfers">Запросить место</CatalogueLink>
                </>
              )}
              {load.data.transfer.state === 'empty' && (
                <div>
                  <p className="text-sm text-[var(--text-secondary)]">
                    С {fmtDay(load.data.transfer.window.from)} по {fmtDay(load.data.transfer.window.to)} поездок перевозчиков, где хватит мест на всю группу ({load.data.transfer.window.seats} чел.), на платформе нет.
                  </p>
                  <CatalogueLink href="/transfers">Поездки перевозчиков</CatalogueLink>
                </div>
              )}
              {load.data.transfer.state === 'unavailable' && <Unavailable what="поездки перевозчиков" />}
            </div>
          )}

          {load.data.car && (
            <div className="space-y-1" data-testid="extras-car">
              <p className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
                <Car className="w-4 h-4 text-[var(--ocean)]" />Машина напрокат
              </p>
              <p className="text-sm text-[var(--text-primary)]">{load.data.car.message}</p>
              <p className="text-xs text-[var(--text-secondary)]">{load.data.car.hint}</p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
