import { KuzmichActions } from '@/components/shared/KuzmichActions';

export { KUZMICH_TELEGRAM_URL, KUZMICH_MAX_URL } from '@/components/shared/KuzmichActions';

/**
 * Встроенный блок «Спросить Кузьмича» — в потоке страницы, не плавающий.
 *
 * Замена плавающей кнопки подбора (StickyLeadButton, удалён 19.10
 * по слову владельца: «подобрать тур устарела, единственное — ссылка на
 * ТГ и MAX Кузьмича»). Плавающую пару не делаем: на сайте уже плавают чат
 * Кузьмича (KuzmichWidget, правый нижний угол) и нижнее меню, и на 390px
 * оранжевая таблетка ложилась на «Как заказать» (скрин владельца, Шатун).
 * В потоке блок ничего не перекрывает, цели — не ниже 44px.
 * Действия — единая система KuzmichActions: «Спросить на сайте» с фирменным
 * знаком чата Ведара и равные Telegram/MAX с официальными знаками.
 */
export default function KuzmichContacts({ className = '' }: { className?: string }) {
  return (
    <section aria-labelledby="kuzmich-contacts-title" className={`ds-card p-5 ${className}`}>
      <h2 id="kuzmich-contacts-title" className="font-semibold text-[var(--text-primary)] text-base mb-1">
        Спросить Кузьмича
      </h2>
      <p className="text-sm text-[var(--text-secondary)] mb-4">
        Кузьмич отвечает в мессенджерах: про туры, трансферы, погоду и обстановку на Камчатке.
      </p>
      <KuzmichActions primaryHref="/kuzmich" />
    </section>
  );
}
