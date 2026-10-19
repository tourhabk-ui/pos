import Link from 'next/link';
import { KUZMICH_TELEGRAM_URL, KUZMICH_MAX_URL } from '@/components/shared/KuzmichContacts';
import { TelegramIcon, MaxIcon } from '@/components/shared/MessengerIcons';

/**
 * Действия блока «Проводник Кузьмич» на мобильной главной: одна главная
 * дорога на сайт и две равные — в мессенджеры с официальными знаками.
 * Адреса — те же константы, что и везде (Telegram ?start=lead, MAX-бот).
 */
export function KuzmichGuideActions() {
  return (
    <div className="acts">
      <Link className="ask-site" href="/kuzmich">Спросить на сайте</Link>
      <div className="messengers">
        <a className="msg" href={KUZMICH_TELEGRAM_URL} target="_blank" rel="noopener noreferrer" aria-label="Кузьмич в Telegram">
          <TelegramIcon size={22} />
          <span>Telegram</span>
        </a>
        <a className="msg" href={KUZMICH_MAX_URL} target="_blank" rel="noopener noreferrer" aria-label="Кузьмич в MAX">
          <MaxIcon size={22} />
          <span>MAX</span>
        </a>
      </div>
    </div>
  );
}
