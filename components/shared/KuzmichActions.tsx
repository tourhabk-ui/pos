import Link from 'next/link';
import { TelegramIcon, MaxIcon, VedarChatIcon } from '@/components/shared/MessengerIcons';

/**
 * Кузьмич в мессенджерах — единственные внешние ссылки на бота.
 * URL взяты из прежнего попапа StickyLeadButton и /contact (19.10):
 * Telegram — @kuzmichai_bot с lead-меткой, MAX — бот id4101147649_bot.
 * Не выдумывать новые инвайты: другого MAX-URL у бота в проекте нет
 * (id4101147649_biz в футере — канал, не бот). KuzmichContacts реэкспортирует
 * эти константы, чтобы прежние импорты не расходились.
 */
export const KUZMICH_TELEGRAM_URL = 'https://t.me/kuzmichai_bot?start=lead';
export const KUZMICH_MAX_URL = 'https://max.ru/id4101147649_bot';

/**
 * Единая система действий Кузьмича (с #2599, расширена фирменным знаком чата):
 * главная кнопка «Спросить на сайте» с фирменным знаком чата Ведара
 * (VedarChatIcon), под ней — две равные кнопки мессенджеров с официальными
 * знаками Telegram и MAX. Цели — не ниже 48px. Адреса мессенджеров — те же
 * константы, что и везде, байт-в-байт.
 *
 * primaryHref/primaryLabel задаёт место: цель и текст главной дороги не
 * меняются от переодевания (на карточке тура это по-прежнему планировщик
 * с его прежней подписью). tone="dark" — для тёмной панели DeskHelp.
 */
export function KuzmichActions({
  primaryHref,
  primaryLabel = 'Спросить на сайте',
  tone = 'light',
  compact = false,
}: {
  primaryHref: string;
  primaryLabel?: string;
  tone?: 'light' | 'dark';
  compact?: boolean;
}) {
  const messengerClass =
    tone === 'dark'
      ? 'inline-flex min-h-[48px] items-center justify-center gap-2 rounded-[14px] border border-white/25 bg-white/10 px-3 text-sm font-semibold text-white transition-colors hover:bg-white/15'
      : 'inline-flex min-h-[48px] items-center justify-center gap-2 rounded-[14px] border border-[var(--border-strong)] bg-[var(--bg-card)] px-3 text-sm font-semibold text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]';
  return (
    <div className="flex flex-col gap-2.5">
      <Link
        href={primaryHref}
        className={`inline-flex ${compact ? 'min-h-[48px]' : 'min-h-[52px]'} items-center justify-center gap-2.5 rounded-[14px] bg-[var(--accent)] px-5 text-[15px] font-bold text-[var(--on-accent)] shadow-[0_8px_20px_color-mix(in_srgb,var(--accent)_32%,transparent)] transition-opacity hover:opacity-95`}
      >
        <VedarChatIcon size={compact ? 22 : 24} />
        <span>{primaryLabel}</span>
      </Link>
      <div className="grid grid-cols-2 gap-2.5">
        <a className={messengerClass} href={KUZMICH_TELEGRAM_URL} target="_blank" rel="noopener noreferrer" aria-label="Кузьмич в Telegram">
          <TelegramIcon size={22} />
          <span>Telegram</span>
        </a>
        <a className={messengerClass} href={KUZMICH_MAX_URL} target="_blank" rel="noopener noreferrer" aria-label="Кузьмич в MAX">
          <MaxIcon size={22} />
          <span>MAX</span>
        </a>
      </div>
    </div>
  );
}
