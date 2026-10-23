import Link from 'next/link';
import { TelegramIcon, MaxIcon, VedarChatIcon } from '@/components/shared/MessengerIcons';

/**
 * Кузьмич в мессенджерах — единственные внешние ссылки на бота.
 * URL взяты из прежнего попапа StickyLeadButton и /contact (19.10):
 * Telegram — @kuzmichai_bot с lead-меткой, MAX — бот id4101147649_bot.
 * Не выдумывать новые инвайты: другого MAX-URL у бота в проекте нет
 * (id4101147649_biz в футере — канал, не бот). KuzmichContacts реэкспортирует
 * эти константы, чтобы прежние импорты не расходились.
 *
 * Обе ссылки — со стартом (`?start=lead`). У MAX это не украшение (вопрос
 * владельца 23.10: «почему при переходе по кнопке max в чате макс нет
 * команды /start»): событие bot_started MAX присылает боту, когда человек
 * переходит по ссылке со стартом (dev.max.ru, «диплинк бота»). Без него
 * человек, уже писавший боту, открывал пустой чат: ни приветствия, ни меню
 * тем. С ним вебхук (app/api/max/kuzmich) отвечает как на /start. Метка
 * `lead` разборщики ссылок подключения не трогают (lib/max/verified-press).
 */
export const KUZMICH_TELEGRAM_URL = 'https://t.me/kuzmichai_bot?start=lead';
export const KUZMICH_MAX_URL = 'https://max.ru/id4101147649_bot?start=lead';

/**
 * Единая система действий Кузьмича: один ряд из трёх стеклянных
 * иконок-кнопок без видимых подписей (слово владельца 20.10: «подписи
 * убрать совсем»). Порядок: фирменный чат Ведара (VedarChatIcon, увеличен
 * до 32px, в компактной плотности — 30px), Telegram, MAX с официальными
 * знаками (28/26px). Имя каждой цели живёт в aria-label и title, цели —
 * не ниже 48px, адреса — те же константы выше, байт-в-байт.
 *
 * Стекло: все три кнопки — одна белая стеклянная семья (слово владельца
 * 20.10: «нашу кнопку тоже белой, инвертируй цвета»): тот же полупрозрачный
 * фон, backdrop-blur и граница, что у Telegram/MAX. Фирменный цвет живёт
 * только в знаке главной кнопки — VedarChatIcon инвертирован в акцентный
 * пузырь с белым силуэтом (accent-bubble), поэтому на тёмной панели знак
 * остаётся читаемым сам по себе. Выделение главной — только размером
 * знака (32/30px против 28/26px у мессенджеров), не цветом подложки.
 * primaryHref/primaryLabel задаёт место: цель и доступное имя главной
 * дороги не меняются от переодевания (на карточке тура это по-прежнему
 * планировщик с именем «Спросить Кузьмича»).
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
  const glassClass =
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
        className={glassClass}
      >
        <VedarChatIcon size={compact ? 30 : 32} variant="accent-bubble" />
      </Link>
      <a
        className={glassClass}
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
        className={glassClass}
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
