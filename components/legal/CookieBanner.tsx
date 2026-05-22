'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Script from 'next/script';

const STORAGE_KEY = 'cookie_consent';
type Consent = 'all' | 'necessary' | null;

function loadAnalytics(ymId: string | undefined, clarityId: string | undefined) {
  if (typeof window === 'undefined') return;

  if (ymId && !window.__ym_loaded) {
    window.__ym_loaded = true;
    const ymIdNum = Number(ymId);
    const s = document.createElement('script');
    s.src = 'https://mc.yandex.ru/metrika/tag.js';
    s.async = true;
    s.onload = () => {
      (window as unknown as { ym?: (id: number, action: string, params: object) => void })
        .ym?.(ymIdNum, 'init', { clickmap: true, trackLinks: true, accurateTrackBounce: true, webvisor: true });
    };
    document.head.appendChild(s);
  }

  if (clarityId && !window.__clarity_loaded) {
    window.__clarity_loaded = true;
    const s = document.createElement('script');
    s.async = true;
    s.src = `https://www.clarity.ms/tag/${clarityId}`;
    document.head.appendChild(s);
  }
}

export default function CookieBanner() {
  const [consent, setConsent] = useState<Consent | 'pending'>('pending');

  const ymId = process.env.NEXT_PUBLIC_YANDEX_METRIKA_ID;
  const clarityId = process.env.NEXT_PUBLIC_CLARITY_ID;

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY) as Consent;
    if (stored === 'all') {
      setConsent('all');
      loadAnalytics(ymId, clarityId);
    } else if (stored === 'necessary') {
      setConsent('necessary');
    } else {
      setConsent(null);
    }
  }, [ymId, clarityId]);

  function accept() {
    localStorage.setItem(STORAGE_KEY, 'all');
    setConsent('all');
    loadAnalytics(ymId, clarityId);
  }

  function necessary() {
    localStorage.setItem(STORAGE_KEY, 'necessary');
    setConsent('necessary');
  }

  if (consent !== null) return null;

  return (
    <div
      role="dialog"
      aria-label="Использование файлов cookie"
      className="fixed bottom-0 left-0 right-0 z-[9999] px-4 pb-4 md:px-6 md:pb-6"
    >
      <div className="max-w-4xl mx-auto bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-lg p-4 md:p-5 flex flex-col md:flex-row md:items-center gap-4">
        <p className="text-sm text-[var(--text-secondary)] flex-1 leading-relaxed">
          Мы используем cookies для аналитики и улучшения сервиса. Данные хранятся на серверах в России
          согласно&nbsp;
          <Link href="/legal/privacy" className="text-[var(--accent)] underline underline-offset-2">
            политике конфиденциальности
          </Link>
          &nbsp;(152-ФЗ).
        </p>
        <div className="flex gap-2 shrink-0">
          <button
            onClick={necessary}
            className="ds-btn ds-btn-secondary text-sm px-4 py-2"
          >
            Только необходимые
          </button>
          <button
            onClick={accept}
            className="ds-btn ds-btn-primary text-sm px-4 py-2"
          >
            Принять все
          </button>
        </div>
      </div>
    </div>
  );
}

declare global {
  interface Window {
    __ym_loaded?: boolean;
    __clarity_loaded?: boolean;
  }
}
