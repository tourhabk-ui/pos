'use client';

/**
 * Telegram Login Widget component.
 *
 * Injects the official Telegram login script into the page.
 * When the user confirms in Telegram, `onAuth` is called with their data.
 *
 * Required env var (public):
 *   NEXT_PUBLIC_TELEGRAM_BOT_USERNAME — bot username WITHOUT @
 *   e.g. "KamchatourBot" for @KamchatourBot
 *
 * The bot must also be configured with /setdomain in BotFather. BotFather
 * accepts ONE domain per bot, and the canonical one is vedarai.ru — since the
 * host redirect (next.config.js) that is the only host serving login pages.
 * If /setdomain still points at the legacy host, the widget silently refuses
 * to render and login looks broken with no error anywhere.
 */

import { useEffect, useRef, useState } from 'react';
import { DEFAULT_BOT_USERNAME, envBotUsername } from '@/lib/telegram/bot-username';

export interface TelegramUser {
  id:          number;
  first_name:  string;
  last_name?:  string;
  username?:   string;
  photo_url?:  string;
  auth_date:   number;
  hash:        string;
}

interface Props {
  onAuth: (user: TelegramUser) => void;
}

/**
 * Имя бота для виджета: переменная сборки, если она похожа на username,
 * иначе @kuzmichai_bot (домен vedarai.ru выставлен в BotFather 20.10).
 * Раньше без переменной кнопка не рисовалась вовсе.
 */
const LOGIN_BOT = envBotUsername() ?? DEFAULT_BOT_USERNAME;

const WIDGET_ORIGIN = 'https://oauth.telegram.org';

/**
 * Свой iframe вместо telegram-widget.js: скрипт Telegram разбирает
 * data-onauth через eval, а CSP сайта eval не пускает (21.10, прод) —
 * кнопка не появлялась. Iframe тот же, что строит их скрипт; ответ входа
 * приходит postMessage-событием auth_user только с oauth.telegram.org.
 */
export default function TelegramLoginButton({ onAuth }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [height, setHeight] = useState(40);

  useEffect(() => {
    const q = new URLSearchParams({
      origin: window.location.origin,
      return_to: window.location.href,
      size: 'large',
      radius: '8',
      request_access: 'write',
    });
    setSrc(`${WIDGET_ORIGIN}/embed/${LOGIN_BOT}?${q.toString()}`);

    function onMessage(e: MessageEvent) {
      if (e.origin !== WIDGET_ORIGIN || e.source !== frame.current?.contentWindow) return;
      let data: { event?: string; height?: number; init?: boolean; auth_data?: TelegramUser } = {};
      try { data = JSON.parse(String(e.data)); } catch { return; }
      if (data.event === 'resize' && data.height) setHeight(data.height);
      if (data.event === 'auth_user' && !data.init && data.auth_data) onAuth(data.auth_data);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex justify-center">
      {src && (
        <iframe
          ref={frame}
          src={src}
          title="Войти через Telegram"
          scrolling="no"
          style={{ width: 238, height, border: 'none', overflow: 'hidden', colorScheme: 'light' }}
        />
      )}
    </div>
  );
}
