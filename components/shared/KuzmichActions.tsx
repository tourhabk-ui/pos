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
 * Единая система действий Кузьмича: один ряд из трёх стеклянных
 * иконок-кнопок без видимых подписей (слово владельца 20.10: «подписи
 * убрать совсем»). Порядок: фирменный чат Ведара (VedarChatIcon, увеличен
 * до 32px, в компактной плотности — 30px), Telegram, MAX с официальными
 * знаками (28/26px). Имя каждой цели живёт в aria-label и title, цели —
 * не ниже 48px, адреса — те же константы выше, байт-в-байт.
 *
 * Стекло: главная кнопка сохраняет фирменный оранжевый акцент, но как
 * градиент с бликом и внутренней кромкой, а не плоскую заливку;
 * мессенджеры — полупрозрачная поверхность с backdrop-blur и мягкой
 * границей. primaryHref/primaryLabel задаёт место: цель и доступное имя
 * главной дороги не меняются от переодевания (на карточке тура это
 * по-прежнему планировщик с именем «Спросить Кузьмича»).
 * tone="dark" — для тёмной панели DeskHelp.
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
  const height = compact ? 'min-h-[48px]' : 'min-h-[52px]';
  const messengerClass =
    tone === 'dark'
      ? `${height} inline-flex flex-1 items-center justify-center rounded-[16px] border border-white/30 bg-white/10 px-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_8px_20px_rgba(0,0,0,0.18)] backdrop-blur-md transition-colors hover:bg-white/15`
      : `${height} inline-flex flex-1 items-center justify-center rounded-[16px] border border-[var(--border-strong)] bg-[color-mix(in_srgb,var(--bg-card)_62%,transparent)] px-3 shadow-[inset_0_1px_0_color-mix(in_srgb,#ffffff_45%,transparent),0_8px_20px_rgba(0,0,0,0.07)] backdrop-blur-md transition-colors hover:bg-[var(--bg-hover)]`;
  return (
    <div className="flex items-stretch gap-2.5" role="group" aria-label="Спросить Кузьмича">
      <Link
        href={primaryHref}
        aria-label={primaryLabel}
        title={primaryLabel}
        data-kuzmich-action="site"
        className={`${height} inline-flex flex-1 items-center justify-center rounded-[16px] border border-white/40 backdrop-blur-md transition-opacity hover:opacity-95`}
        style={{
          background:
            'linear-gradient(135deg, color-mix(in srgb, var(--accent) 76%, #ffffff 24%) 0%, var(--accent) 52%, color-mix(in srgb, var(--accent) 84%, #000000 16%) 100%)',
          boxShadow:
            'inset 0 1px 0 rgba(255,255,255,0.5), inset 0 -1px 0 rgba(0,0,0,0.14), 0 10px 24px color-mix(in srgb, var(--accent) 32%, transparent)',
        }}
      >
        <VedarChatIcon size={compact ? 30 : 32} />
      </Link>
      <a
        className={messengerClass}
        href={KUZMICH_TELEGRAM_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Telegram"
        title="Telegram"
        data-kuzmich-action="telegram"
      >
        <TelegramIcon size={compact ? 26 : 28} />
      </a>
      <a
        className={messengerClass}
        href={KUZMICH_MAX_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="MAX"
        title="MAX"
        data-kuzmich-action="max"
      >
        <MaxIcon size={compact ? 26 : 28} />
      </a>
    </div>
  );
}
