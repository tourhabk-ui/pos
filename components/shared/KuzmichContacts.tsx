import { MessageCircle, Send } from 'lucide-react';

/**
 * Кузьмич в мессенджерах — единственные внешние ссылки на бота.
 * URL взяты из прежнего попапа StickyLeadButton и /contact (19.10):
 * Telegram — @kuzmichai_bot с lead-меткой, MAX — бот id4101147649_bot.
 * Не выдумывать новые инвайты: другого MAX-URL у бота в проекте нет
 * (id4101147649_biz в футере — канал, не бот).
 */
export const KUZMICH_TELEGRAM_URL = 'https://t.me/kuzmichai_bot?start=lead';
export const KUZMICH_MAX_URL = 'https://max.ru/id4101147649_bot';

/**
 * Встроенный блок «Спросить Кузьмича» — в потоке страницы, не плавающий.
 *
 * Замена плавающей кнопки подбора (StickyLeadButton, удалён 19.10
 * по слову владельца: «подобрать тур устарела, единственное — ссылка на
 * ТГ и MAX Кузьмича»). Плавающую пару не делаем: на сайте уже плавают чат
 * Кузьмича (KuzmichWidget, правый нижний угол) и нижнее меню, и на 390px
 * оранжевая таблетка ложилась на «Как заказать» (скрин владельца, Шатун).
 * В потоке блок ничего не перекрывает, цели — не ниже 44px.
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
      <div className="flex flex-col sm:flex-row gap-2">
        <a
          href={KUZMICH_TELEGRAM_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="flex-1 inline-flex items-center justify-center gap-2 min-h-[44px] px-4 rounded-lg text-sm font-semibold text-white transition-opacity hover:opacity-90"
          style={{ background: 'var(--telegram)' }}
        >
          <Send className="w-4 h-4" aria-hidden /> Кузьмич в Telegram
        </a>
        <a
          href={KUZMICH_MAX_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="flex-1 inline-flex items-center justify-center gap-2 min-h-[44px] px-4 rounded-lg text-sm font-semibold text-white transition-opacity hover:opacity-90"
          style={{ background: 'var(--purple)' }}
        >
          <MessageCircle className="w-4 h-4" aria-hidden /> Кузьмич в MAX
        </a>
      </div>
    </section>
  );
}
