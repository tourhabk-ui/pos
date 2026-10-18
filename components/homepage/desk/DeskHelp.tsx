import Link from 'next/link';
import { ArrowRight, MessageCircle, Send, WifiOff } from 'lucide-react';
import { KUZMICH_TELEGRAM_URL, KUZMICH_MAX_URL } from '@/components/shared/KuzmichContacts';

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
        {/* Тот же Кузьмич в мессенджерах, что и на мобильной главной
            (PR #2580): десктопное дерево главной — отдельное, и внешних
            ссылок на бота здесь не было вовсе. Цели от 44px. */}
        <div className="mt-auto flex flex-col sm:flex-row gap-2">
          <a href={KUZMICH_TELEGRAM_URL} target="_blank" rel="noopener noreferrer" className="flex-1 inline-flex items-center justify-center gap-2 min-h-[44px] px-4 rounded-lg text-sm font-semibold text-white transition-opacity hover:opacity-90" style={{ background: 'var(--telegram)' }}>
            <Send size={16} aria-hidden /> Кузьмич в Telegram
          </a>
          <a href={KUZMICH_MAX_URL} target="_blank" rel="noopener noreferrer" className="flex-1 inline-flex items-center justify-center gap-2 min-h-[44px] px-4 rounded-lg text-sm font-semibold text-white transition-opacity hover:opacity-90" style={{ background: 'var(--purple)' }}>
            <MessageCircle size={16} aria-hidden /> Кузьмич в MAX
          </a>
        </div>
        <Link href="/kuzmich" className="inline-flex items-center gap-1.5 text-sm font-semibold text-white/90 hover:text-white">
          Спросить на сайте <ArrowRight size={16} aria-hidden />
        </Link>
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
