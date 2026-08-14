'use client';

/**
 * Ловец реферального кода. Разметки не даёт — только запоминает `?ref=` при
 * входе на любую страницу.
 *
 * Стоит в корневом лейауте, потому что приглашение приземляется куда угодно:
 * ссылка из кабинета лояльности ведёт на главную, кнопка «поделиться» с
 * карточки тура — на карточку. Ловить только на главной значило бы терять
 * ровно те приглашения, где приглашающий показал конкретное место.
 */

import { useEffect } from 'react';
import { readReferralFromSearch, saveReferral } from '@/lib/referral/link';

export function ReferralCapture() {
  useEffect(() => {
    const code = readReferralFromSearch(window.location.search);
    if (code) saveReferral(code, Date.now());
  }, []);

  return null;
}

export default ReferralCapture;
