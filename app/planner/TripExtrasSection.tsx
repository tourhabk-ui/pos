'use client';

/**
 * «Что ещё нужно» на экране результата планера (решение владельца 26.09):
 * настоящее жильё на ночи плана, перевозчики «под заказ» и прокатчики с
 * прайсом за сутки без водителя (23.10; до того — честное «пока нет»).
 *
 * Здесь только то, что лежит на платформе. Оценка стоимости проживания и
 * транспорта — выше, в «Оценке стоимости», и подписана оценкой: одно не
 * выдаётся за другое (§4.0).
 *
 * У каждого ответа три исхода: варианты; «на платформе нет» со ссылкой на
 * каталог; «не смогли проверить» — это не «нет», и экран так и говорит.
 *
 * Жильё можно взять в план (#2304, шаг 3): выбранное встаёт в смету своей
 * ценой вместо ориентира и уходит в заявку (lib/planner/plan-choices).
 * Трансфер — машина целиком под заказ (владелец 13.10): в план его не берут
 * и в смету он не встаёт — цена зависит от направления, которое заказчик
 * пишет в заявке на странице перевозчика; туда и ведёт строка.
 */

import Link from 'next/link';
import { BedDouble, Bus, Car, Star, ArrowRight, AlertTriangle, BadgeCheck, Check } from 'lucide-react';
import { ACCOMMODATION_TYPE_LABELS } from '@/lib/stay/accommodation-types';
import { stayLink } from '@/lib/stay/stay-link';
import { carrierPagePath } from '@/lib/transfers/charter-format';
import { rentalPagePath } from '@/lib/rental/rental-format';
import { stayKey, type ChoiceSelection } from '@/lib/planner/plan-choices';
import type {
  TripExtrasData, LodgingStayView, LodgingOptionView, CharterOfferView, RentalOfferSummaryView,
} from './planner-types';

/** Состав плана: для ссылок на жильё с гостями. */
export interface ExtrasParty {
  adults: number;
  children: number[];
}

/** Выбор жилья: нет обработчика — блок только показывает. */
export interface ExtrasChoiceProps {
  selection?: ChoiceSelection;
  onToggleLodging?: (stayKey: string, accommodationId: string) => void;
  party?: ExtrasParty;
}

export type ExtrasLoad =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; data: TripExtrasData };

const TYPE_LABELS: Record<string, string> = ACCOMMODATION_TYPE_LABELS;

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

function roomsRu(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} номер`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} номера`;
  return `${n} номеров`;
}

/** Кнопка «взять в план»: нажата — пункт плана, повторное нажатие — снять. */
function PlanToggle({ chosen, onClick, label }: { chosen: boolean; onClick: () => void; label: string }) {
  return (
    <button type="button" aria-pressed={chosen} aria-label={`${chosen ? 'Убрать из плана' : 'Взять в план'}: ${label}`} onClick={onClick}
      className={`ds-btn ${chosen ? 'ds-btn-primary' : 'ds-btn-secondary'} shrink-0 px-3 text-sm`}>
      {chosen && <Check className="w-4 h-4" />}
      {chosen ? 'В плане' : 'В план'}
    </button>
  );
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

function LodgingItem({ o, stay, chosen, onToggle, party }: {
  o: LodgingOptionView;
  stay: LodgingStayView;
  chosen: boolean;
  onToggle?: () => void;
  party?: ExtrasParty;
}) {
  const href = party
    ? stayLink(o.id, {
      checkIn: stay.checkIn, checkOut: stay.checkOut, adults: party.adults, children: party.children.length,
      ...(o.stay?.kind === 'priced' ? { roomId: o.stay.roomId, rooms: o.stay.rooms } : {}),
    })
    : `/accommodations/${o.id}`;
  return (
    <li data-testid="lodging-option"
      className={`rounded-lg border bg-[var(--bg-card)] px-3 py-2.5 transition-colors duration-200 motion-reduce:transition-none ${chosen ? 'border-[var(--accent)]' : 'border-[var(--border)]'}`}>
      <div className="flex items-start justify-between gap-3">
        <span className="min-w-0">
          <Link href={href} className="flex items-center gap-1.5 min-h-[24px] text-sm font-medium text-[var(--text-primary)]">
            <span className="truncate">{o.name}</span>
            {o.isVerified && <BadgeCheck className="w-4 h-4 shrink-0 text-[var(--success)]" aria-label="Проверено платформой" />}
          </Link>
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
          {o.stay?.kind === 'priced'
            ? <>{fmtRub(o.stay.total)}<span className="block text-[10px] text-[var(--text-muted)]">на группу за {nightsRu(stay.nights)}</span></>
            : o.priceFrom === null
              ? <span className="text-xs text-[var(--text-muted)]">цена не указана</span>
              : <>от {fmtRub(o.priceFrom)}<span className="block text-[10px] text-[var(--text-muted)]">за номер в ночь</span></>}
        </span>
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <span className="text-xs text-[var(--text-secondary)]">
          {o.stay?.kind === 'priced'
            ? `${roomsRu(o.stay.rooms)} «${o.stay.roomName}», до ${o.stay.maxGuests} гостей в номере`
            : o.stay?.kind === 'no_fit'
              ? 'Группа целиком в один тип номеров не помещается — номера подберёт хозяин'
              : 'Цену на группу посчитаем в карточке объекта'}
        </span>
        {onToggle && <PlanToggle chosen={chosen} onClick={onToggle} label={o.name} />}
      </div>
    </li>
  );
}

function StayBlock({ stay, choice }: { stay: LodgingStayView; choice: ExtrasChoiceProps }) {
  const key = stayKey(stay);
  const chosenId = choice.selection?.lodging[key];
  const onToggleLodging = choice.onToggleLodging;
  return (
    <div className="space-y-2" data-testid="lodging-stay">
      <p className="text-sm text-[var(--text-primary)]">
        <span className="font-semibold">{stay.zoneName}</span>
        <span className="text-[var(--text-secondary)]"> · {nightsRu(stay.nights)}, {fmtDay(stay.checkIn)} — {fmtDay(stay.checkOut)}</span>
      </p>
      {stay.result.state === 'ok' && (
        <ul className="space-y-1.5">
          {stay.result.items.map((o) => (
            <LodgingItem key={o.id} o={o} stay={stay} chosen={chosenId === o.id} party={choice.party}
              onToggle={onToggleLodging ? () => onToggleLodging(key, o.id) : undefined} />
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

function directionsRu(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} направление`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} направления`;
  return `${n} направлений`;
}

/**
 * Цена перевозчика одной строкой: «от N за машину · M направлений в прайсе»,
 * у цены за время работы (1292) — «N в час · M за день за машину»; цены нет —
 * «назовёт перевозчик».
 */
export function charterOfferPrice(o: Pick<CharterOfferView, 'priceFromRub' | 'destinations' | 'hourRub' | 'dayRub' | 'ratesFrom'>): string {
  if (o.priceFromRub !== null) return `от ${fmtRub(o.priceFromRub)} за машину · ${directionsRu(o.destinations)} в прайсе`;
  // Тарифы на разные виды машин (1318) — названа самая низкая, и это «от».
  const from = o.ratesFrom === true ? 'от ' : '';
  const byTime = [
    typeof o.hourRub === 'number' ? `${from}${fmtRub(o.hourRub)} в час` : null,
    typeof o.dayRub === 'number' ? `${from}${fmtRub(o.dayRub)} за день` : null,
  ].filter(Boolean);
  if (byTime.length > 0) return `${byTime.join(' · ')} за машину · направление — ваше`;
  return 'Цену машины назовёт перевозчик';
}

/** Перевозчик «под заказ»: машина целиком, цена за машину; строка ведёт на его прайс и заявку. */
function CharterOfferRow({ o }: { o: CharterOfferView }) {
  return (
    <li data-testid="charter-offer" className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] px-3 py-2.5">
      <Link href={carrierPagePath(o.slug)} className="text-sm font-medium text-[var(--text-primary)]">
        {o.name}
      </Link>
      {o.fleet && <p className="text-xs text-[var(--text-secondary)] mt-0.5">{o.fleet}</p>}
      <p className="text-xs text-[var(--text-secondary)] mt-0.5">{charterOfferPrice(o)}</p>
    </li>
  );
}

function carsRu(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} машина`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} машины`;
  return `${n} машин`;
}

/** Строка прокатчика: цена «от» за сутки без водителя; нет цены — не выдумывается. */
export function rentalOfferLine(o: Pick<RentalOfferSummaryView, 'priceFromRub' | 'offers' | 'driverOptional'>): string {
  const price = o.priceFromRub !== null ? `от ${fmtRub(o.priceFromRub)} за сутки без водителя` : 'Цену назовёт прокатчик';
  const driver = o.driverOptional ? ' · водитель по желанию, цена отдельно' : '';
  return `${price} · ${carsRu(o.offers)} в прайсе${driver}`;
}

/** Прокатчик (23.10): машина без водителя за сутки; строка ведёт на его прайс и заявку. В план не берётся — цена зависит от дней и машины. */
function RentalOfferRow({ o }: { o: RentalOfferSummaryView }) {
  return (
    <li data-testid="rental-offer" className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] px-3 py-2.5">
      <Link href={rentalPagePath(o.slug)} className="text-sm font-medium text-[var(--text-primary)]">
        {o.name}
      </Link>
      <p className="text-xs text-[var(--text-secondary)] mt-0.5">{rentalOfferLine(o)}</p>
    </li>
  );
}

export function TripExtrasSection({ load, ...choice }: {
  load: ExtrasLoad;
} & ExtrasChoiceProps) {
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
                  {load.data.lodging.stays.map((s) => <StayBlock key={stayKey(s)} stay={s} choice={choice} />)}
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
                <Bus className="w-4 h-4 text-[var(--ocean)]" />Трансфер — машина целиком
              </p>
              {load.data.transfer.state === 'ok' && (
                <>
                  <p className="text-xs text-[var(--text-secondary)]">
                    Под заказ: цена за машину, не за место. Направление и даты укажете в заявке на странице перевозчика; машину подтверждает менеджер Ведара, расчёт — напрямую с перевозчиком.
                  </p>
                  <ul className="space-y-1.5">
                    {load.data.transfer.items.map((o) => <CharterOfferRow key={o.slug} o={o} />)}
                  </ul>
                </>
              )}
              {load.data.transfer.state === 'empty' && (
                <div>
                  <p className="text-sm text-[var(--text-secondary)]">
                    Перевозчиков с прайсом под заказ на платформе пока нет.
                  </p>
                  <CatalogueLink href="/transfers">Трансферы</CatalogueLink>
                </div>
              )}
              {load.data.transfer.state === 'unavailable' && <Unavailable what="машины под заказ" />}
            </div>
          )}

          {load.data.car && (
            <div className="space-y-2" data-testid="extras-car">
              <p className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
                <Car className="w-4 h-4 text-[var(--ocean)]" />Машина напрокат
              </p>
              {load.data.car.state === 'ok' && (
                <>
                  <p className="text-xs text-[var(--text-secondary)]">
                    Без водителя, цена за сутки за машину по прайсу прокатчика. Даты и машину укажете в заявке на его странице; машину подтверждает менеджер Ведара, расчёт — напрямую с прокатчиком.
                  </p>
                  <ul className="space-y-1.5">
                    {load.data.car.items.map((o) => <RentalOfferRow key={o.slug} o={o} />)}
                  </ul>
                  <CatalogueLink href="/car-rental">Все прокатчики</CatalogueLink>
                </>
              )}
              {load.data.car.state === 'not_offered' && (
                <>
                  <p className="text-sm text-[var(--text-primary)]">{load.data.car.message}</p>
                  <p className="text-xs text-[var(--text-secondary)]">{load.data.car.hint}</p>
                </>
              )}
              {load.data.car.state === 'unavailable' && <Unavailable what="прокат автомобилей" />}
            </div>
          )}
        </>
      )}
    </section>
  );
}
