import { KuzmichActions } from '@/components/shared/KuzmichActions';

/**
 * Действия блока «Проводник Кузьмич» на мобильной главной — та же единая
 * система, что и везде: «Спросить на сайте» с фирменным знаком чата Ведара
 * и две равные дороги в мессенджеры с официальными знаками.
 */
export function KuzmichGuideActions() {
  return <KuzmichActions primaryHref="/kuzmich" />;
}
