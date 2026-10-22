import { KuzmichActions } from '@/components/shared/KuzmichActions';

/**
 * Действия блока «Проводник Кузьмич» на мобильной главной — та же единая
 * система, что и везде: один ряд из трёх стеклянных иконок-кнопок без
 * подписей (фирменный чат Ведара, Telegram, MAX), имена — в aria-label.
 */
export function KuzmichGuideActions() {
  return <KuzmichActions primaryHref="/kuzmich" />;
}
