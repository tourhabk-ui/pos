import RouteLoading from '@/components/shared/RouteLoading';

// Скелет перехода: /transfers стал целью кнопки на главной (09.10), и до
// готовности страницы (она читает прайс из базы) человек видел бы старый экран.
export default function Loading() {
  return <RouteLoading />;
}
