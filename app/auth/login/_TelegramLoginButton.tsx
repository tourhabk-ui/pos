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

import { useEffect, useRef } from 'react';

export interface TelegramUser {
  id:          number;
  first_name:  string;
  last_name?:  string;
  username?:   string;
  photo_url?:  string;
  auth_date:   number;
  hash:        string;
}

declare global {
  interface Window {
    onTelegramAuth?: (user: TelegramUser) => void;
  }
}

interface Props {
  onAuth: (user: TelegramUser) => void;
}

export default function TelegramLoginButton({ onAuth }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const botUsername = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME;
    if (!botUsername || !ref.current) return;

    // Register global callback (required by TG widget)
    window.onTelegramAuth = onAuth;

    const script = document.createElement('script');
    script.src = 'https://telegram.org/js/telegram-widget.js?22';
    script.async = true;
    script.setAttribute('data-telegram-login', botUsername);
    script.setAttribute('data-size', 'large');
    script.setAttribute('data-radius', '8');
    script.setAttribute('data-onauth', 'onTelegramAuth(user)');
    script.setAttribute('data-request-access', 'write');

    ref.current.innerHTML = '';
    ref.current.appendChild(script);

    return () => {
      if (ref.current) ref.current.innerHTML = '';
      delete window.onTelegramAuth;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // If bot username isn't configured, render nothing
  if (!process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME) return null;

  return <div ref={ref} className="flex justify-center" />;
}
