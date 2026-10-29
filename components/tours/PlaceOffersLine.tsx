import Link from 'next/link';
import { MapPin } from 'lucide-react';
import { plural } from '@/lib/home/data-freshness';
import { ruPlacePath } from '@/lib/zh/pages';

/**
 * «К месту «X» есть ещё N предложений — посмотреть» на карточке тура
 * (слово владельца 29.10, «3 да»).
 *
 * Строка нейтральная: без цен и без слов «дешевле», «лучше», «выгоднее» —
 * она говорит лишь, что к тому же месту ездят и другие туры, и ведёт на
 * «Туры к этому месту» карточки места (якорь #tours), где они все стоят по
 * правилу 1в. Число — только по записанной связи тура с местом
 * (`operator_tours.main_place_id`), тем же загрузчиком, что у карточки места
 * (lib/places/place-tours, loadPlaceOffersForTour).
 *
 * Связи нет, других туров нет или чтение не удалось — строки нет: она
 * необязательна, а отказ уже записан в лог загрузчиком.
 *
 * Только для /catalog/tours/[id]. Своя витрина партнёра (его страница, сайт,
 * виджет) строку не показывает: там его закрепление, а не общая витрина (§0).
 *
 * Вынесено в свой компонент, чтобы сторож (tests/unit/tour-place-offers)
 * проверял строку рендером.
 */
export type PlaceOffersView =
  | { state: 'ok'; place: { id: string; name: string; slug: string | null; ark_id: string | null }; others: number }
  | { state: 'none' }
  | { state: 'failed' };

export function PlaceOffersLine({ offers }: { offers: PlaceOffersView | null | undefined }) {
  if (!offers || offers.state !== 'ok' || offers.others <= 0) return null;
  const { place, others } = offers;
  return (
    <p className="text-sm text-[var(--text-secondary)] flex items-start gap-2">
      <MapPin className="w-4 h-4 mt-0.5 shrink-0 text-[var(--ocean)]" aria-hidden="true" />
      <span>
        К месту «{place.name}» есть ещё {others} {plural(others, 'предложение', 'предложения', 'предложений')}
        {' — '}
        <Link
          href={`${ruPlacePath(place)}#tours`}
          className="text-[var(--ocean)] underline underline-offset-2 hover:no-underline"
        >
          посмотреть
        </Link>
      </span>
    </p>
  );
}
