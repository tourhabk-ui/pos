/**
 * Цена маршрута на карточке каталога — из его туров (слово владельца 18.11
 * «1», lib/routes/route-tour-price): «от 18 000 ₽ за человека · самая низкая
 * из 3 туров» или «18 000 ₽ за человека · цена тура». Цены нет — строки нет:
 * своей цены у маршрута не бывает, и «не знаем» не рисуется нулём.
 */
import { routeTourPriceWords, type RouteTourPrice } from '@/lib/routes/route-tour-price';

export default function RouteTourPriceLine({ price }: { price: RouteTourPrice | null | undefined }) {
  const words = routeTourPriceWords(price);
  if (!words) return null;
  return (
    <p className="text-xs leading-snug" data-testid="route-tour-price">
      <span className="font-semibold text-[var(--text-primary)]">{words.price}</span>
      <span className="text-[var(--text-muted)]"> · {words.note}</span>
    </p>
  );
}
