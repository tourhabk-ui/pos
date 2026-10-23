import Link from 'next/link';
import { TelegramIcon, MaxIcon, VedarChatIcon } from '@/components/shared/MessengerIcons';
import { KUZMICH_TELEGRAM_URL, KUZMICH_MAX_URL } from '@/components/shared/KuzmichActions';

/**
 * Кузьмич в герое мобильной главной — столбик круглых стеклянных кнопок под
 * «Поделиться» (слово владельца 23.10: «кнопки чатов хочу сделать ниже кнопки
 * поделиться, размер как у иконки поделиться, сверху вниз, нижняя будет наш
 * сайт»). Сверху вниз: Telegram, MAX, чат на сайте. До этого те же три кнопки
 * стояли рядом в блоке «Проводник Кузьмич» ниже по странице.
 *
 * Адреса и знаки — те же, что у единой системы `KuzmichActions`, байт в байт;
 * имя каждой цели — в aria-label и title, видимой подписи нет. Вид — классы
 * героя (`hero-chat` в стилях главной): то же стекло и тот же размер, что у
 * «Поделиться».
 */
export function HeroKuzmichChats({ siteHref = '/kuzmich' }: { siteHref?: string }) {
  return (
    <div className="hero-chats" role="group" aria-label="Спросить Кузьмича">
      <a
        className="hero-chat"
        href={KUZMICH_TELEGRAM_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Telegram"
        title="Telegram"
        data-kuzmich-action="telegram"
      >
        <TelegramIcon size={22} />
      </a>
      <a
        className="hero-chat"
        href={KUZMICH_MAX_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="MAX"
        title="MAX"
        data-kuzmich-action="max"
      >
        <MaxIcon size={22} />
      </a>
      <Link
        className="hero-chat"
        href={siteHref}
        aria-label="Спросить на сайте"
        title="Спросить на сайте"
        data-kuzmich-action="site"
      >
        <VedarChatIcon size={24} variant="accent-bubble" />
      </Link>
    </div>
  );
}
