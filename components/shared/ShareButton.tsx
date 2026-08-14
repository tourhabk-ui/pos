'use client';

/**
 * Кнопка «поделиться» — единственная на платформе.
 *
 * Главное здесь не иконка, а отклик. Системный лист виден сам; копирование в
 * буфер невидимо, и без подтверждения нажатие неотличимо от отказа — именно
 * так вёл себя лист места до этой правки. Поэтому после `copied` иконка на две
 * секунды становится галкой, а текст исхода уходит в aria-live для тех, кто
 * экран не видит.
 *
 * РЕФЕРАЛ. При `referral` ссылка зарегистрированного человека уходит с его
 * кодом приглашения, гостя — обычной. Код спрашивается на монтировании, а не
 * по нажатию: `navigator.share()` требует свежего пользовательского жеста, и
 * ожидание сети между нажатием и вызовом ломает системный лист в Safari.
 *
 * Класс кнопки задаётся снаружи (на главной v8 — `icn` из шапки), потому что
 * поверхности разные. Это оформление, а не второе поведение: решение об исходе
 * одно, в lib/share.ts.
 */

import { useCallback, useState } from 'react';
import { Share2, Check } from 'lucide-react';
import { shareLink, shareOutcomeMessage, type SharePayload } from '@/lib/share';
import { withReferral } from '@/lib/referral/link';
import { useMyReferralCode } from '@/hooks/useMyReferralCode';

interface ShareButtonProps extends Omit<SharePayload, 'url'> {
  /** Что за ссылка. Пусто — адрес текущей страницы. */
  url?: string;
  /** Подмешивать код приглашения, если человек вошёл. */
  referral?: boolean;
  /**
   * Текст, когда ссылка ушла с кодом приглашения. Отдельный, потому что про
   * бонус за приглашение можно говорить только когда приглашение настоящее:
   * в обычной ссылке обещать его было бы неправдой.
   */
  referralText?: string;
  /** Класс кнопки. Для шапки главной v8 — «icn». */
  className?: string;
  /** Размер иконки в пикселях. */
  size?: number;
  /** Подпись для скринридера. */
  label?: string;
}

const FEEDBACK_MS = 2000;

export function ShareButton({
  title,
  text,
  url,
  referral = false,
  referralText,
  className = '',
  size = 19,
  label = 'Поделиться',
}: ShareButtonProps) {
  const code = useMyReferralCode(referral);
  const [done, setDone] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const onClick = useCallback(async () => {
    // Адрес известен только в браузере, поэтому берётся здесь, а не пропом со
    // сервера: серверный рендер не знает ни хоста, ни строки запроса.
    const href = url || (typeof window !== 'undefined' ? window.location.href : '');
    const outcome = await shareLink({
      title,
      text: code && referralText ? referralText : text,
      url: withReferral(href, code),
    });
    const message = shareOutcomeMessage(outcome);
    if (message) setStatus(message);
    if (outcome === 'copied') {
      setDone(true);
      setTimeout(() => {
        setDone(false);
        setStatus(null);
      }, FEEDBACK_MS);
    }
  }, [title, text, referralText, url, code]);

  return (
    <>
      <button
        type="button"
        onClick={onClick}
        className={className}
        aria-label={label}
        title={label}
      >
        {done ? (
          <Check className="li" size={size} strokeWidth={2} />
        ) : (
          <Share2 className="li" size={size} strokeWidth={2} />
        )}
      </button>
      <span aria-live="polite" className="sr-only">
        {status ?? ''}
      </span>
    </>
  );
}

export default ShareButton;
