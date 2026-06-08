'use client';

import Link from 'next/link';
import { MapPin, RefreshCw } from 'lucide-react';

export default function MapError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--bg-primary)] p-6">
      <div className="text-center max-w-sm">
        <div className="w-16 h-16 mx-auto mb-5 rounded-xl bg-[var(--bg-hover)] flex items-center justify-center">
          <MapPin className="w-8 h-8 text-[var(--text-muted)]" />
        </div>
        <h1 className="font-playfair text-xl font-bold text-[var(--text-primary)] mb-2">
          Карта не загрузилась
        </h1>
        <p className="text-sm text-[var(--text-secondary)] mb-6">
          Обновите страницу — если не помогает, попробуйте очистить кэш браузера.
        </p>
        <div className="flex gap-3 justify-center">
          <button
            onClick={reset}
            className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[var(--accent)] text-white text-sm font-medium hover:opacity-90 transition-opacity"
          >
            <RefreshCw className="w-4 h-4" />
            Обновить
          </button>
          <Link href="/" className="px-5 py-2.5 rounded-lg border border-[var(--border)] text-sm font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors">
            На главную
          </Link>
        </div>
      </div>
    </div>
  );
}
