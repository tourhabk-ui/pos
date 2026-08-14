'use client';

/**
 * Свой код приглашения — если человек вошёл.
 *
 * Спрашивается ЗАРАНЕЕ, на монтировании, а не по нажатию, и это не
 * преждевременная оптимизация. `navigator.share()` требует «свежего»
 * пользовательского жеста: если между нажатием и вызовом вклинить ожидание
 * сети, Safari отвечает NotAllowedError и системный лист не открывается вовсе.
 * Значит к моменту нажатия ссылка должна быть уже собрана.
 *
 * Гость получает 401 и `null` — это ответ, а не сбой: ссылка будет обычной.
 */

import { useEffect, useState } from 'react';
import { isUserReferralCode } from '@/lib/referral/link';

interface CodeResponse {
  success?: boolean;
  data?: { code?: string | null };
}

export function useMyReferralCode(enabled = true): string | null {
  const [code, setCode] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;

    fetch('/api/referral/my-code', { cache: 'no-store' })
      .then((res) => (res.ok ? (res.json() as Promise<CodeResponse>) : null))
      .then((json) => {
        const value = json?.data?.code ?? null;
        if (alive && isUserReferralCode(value)) setCode(value as string);
      })
      .catch(() => {
        // Сети нет или роут упал. Обычная ссылка лучше, чем неработающая
        // кнопка: поделиться человек хотел страницей, а не кодом.
      });

    return () => {
      alive = false;
    };
  }, [enabled]);

  return code;
}
