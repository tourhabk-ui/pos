import RouteLoading from '@/components/shared/RouteLoading';

// Скелет перехода: /car-rental стал целью кнопки «Прокат» на главной (23.10), и
// до готовности страницы (она читает прайс прокатчиков из базы) человек видел
// бы старый экран.
export default function Loading() {
  return <RouteLoading />;
}
