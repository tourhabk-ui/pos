import Link from 'next/link';
import { ArrowRight, MessageCircle, WifiOff } from 'lucide-react';

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
      <Link
        href="/kuzmich"
        className="fx-dark-panel group flex flex-col gap-4 rounded-2xl p-8 no-underline transition-all duration-200 hover:-translate-y-0.5 hover:no-underline hover:shadow-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ocean)] lg:col-span-7"
      >
        <span className="font-playfair text-[28px] italic leading-snug">
          «Про ваши даты скажу по сводке. Чего не знаю — так и скажу».
        </span>
        <span className="fx-dark-muted text-sm">Кузьмич · помощник Ведара · на сайте, в Telegram и MAX</span>
        <span
          className="mt-auto flex h-14 items-center gap-3 rounded-lg border px-4 text-base transition-colors duration-200 group-hover:border-white/30"
          style={{ background: 'rgba(255,255,255,0.08)', borderColor: 'rgba(255,255,255,0.15)' }}
        >
          <MessageCircle size={18} className="fx-dark-muted flex-shrink-0" aria-hidden />
          <span className="fx-dark-muted min-w-0 flex-1 truncate">Можно ли в эти выходные на Авачинский?</span>
          <span className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-full text-white transition-transform duration-200 group-hover:translate-x-0.5" style={{ background: 'var(--accent)' }}>
            <ArrowRight size={16} aria-hidden />
          </span>
        </span>
      </Link>

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
