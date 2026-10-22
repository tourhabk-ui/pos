import Link from 'next/link';
import { ArrowRight, WifiOff } from 'lucide-react';
import { KuzmichActions } from '@/components/shared/KuzmichActions';

/**
 * Кузьмич и подготовка без связи — последний ряд десктопной главной (доска
 * «Десктоп — сводка дня», 30.09).
 *
 * Обещание Кузьмича — ровно то, что он делает: отвечает по той же сводке,
 * что выше на странице, и говорит «не знаю», когда источника нет (§4.0,
 * lib/kuzmich). Каналы — те же, что в MessengerAgentsSection.
 *
 * «Без сети SOS покажет координаты и номера» — так работает офлайн-ветка
 * EmergencyAction (public/emergency.html), это не обещание на вырост.
 */
export function DeskHelp() {
  return (
    <section className="grid grid-cols-1 items-stretch gap-10 lg:grid-cols-12 lg:gap-14" aria-label="Помощь в поездке">
      <div className="fx-dark-panel flex flex-col gap-4 rounded-2xl p-8 lg:col-span-7">
        <span className="font-playfair text-[28px] italic leading-snug">
          «Про ваши даты скажу по сводке. Чего не знаю — так и скажу».
        </span>
        <span className="fx-dark-muted text-sm">Кузьмич · помощник Ведара · на сайте, в Telegram и MAX</span>
        {/* Единая система действий Кузьмича, как на мобильной главной:
            «Спросить на сайте» с фирменным знаком чата и равные
            Telegram/MAX с официальными знаками. Цели не ниже 48px. */}
        <div className="mt-auto">
          <KuzmichActions primaryHref="/kuzmich" tone="dark" />
        </div>
      </div>

      <Link
        href="/prepare"
        className="group flex flex-col justify-between gap-5 border-y border-[var(--border)] py-7 no-underline hover:no-underline lg:col-span-5"
      >
        <span className="grid h-[52px] w-[52px] place-items-center rounded-full bg-[var(--bg-hover)] text-[var(--text-primary)]">
          <WifiOff size={22} aria-hidden />
        </span>
        <span className="flex flex-col gap-1.5">
          <span className="font-playfair text-[26px] font-bold text-[var(--text-primary)]">Едете туда, где нет связи?</span>
          <span className="text-[15px] leading-relaxed text-[var(--text-secondary)]">
            Сохраните карту и маршрут в телефон заранее. Без сети SOS покажет ваши координаты и экстренные номера.
          </span>
        </span>
        <span className="inline-flex items-center gap-1.5 text-base font-semibold text-[var(--ocean)]">
          Подготовить телефон
          <ArrowRight size={18} className="transition-transform duration-200 group-hover:translate-x-1" aria-hidden />
        </span>
      </Link>
    </section>
  );
}
