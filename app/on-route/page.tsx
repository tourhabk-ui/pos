import { redirect } from 'next/navigation';

/**
 * /on-route упразднён (план FCN, этап 3): это был второй полевой экран —
 * копия OnTrailTab без off-track, ETA, прогресса, крошек, качества фикса и
 * офлайн-пакета, зато с подставными координатами при отсутствии GPS и без
 * единого теста. Копии полевых экранов расходятся так же, как расходились
 * копии карточки тура и SOS-кнопки (#887).
 *
 * Данные общие (active_trail_route_id, trail_route_wps_*), поэтому redirect
 * ничего не теряет: активный маршрут откроется в едином полевом режиме.
 */
export default function OnRoutePage() {
  redirect('/planning?mode=trail');
}
