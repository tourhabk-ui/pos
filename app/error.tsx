'use client';

import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="min-h-[100dvh] bg-[var(--bg-primary)] flex items-center justify-center p-6">
      <div className="text-center max-w-md">
        <div className="w-16 h-16 mx-auto mb-6 rounded-lg bg-[var(--danger)]/10 flex items-center justify-center">
          <AlertTriangle className="w-8 h-8 text-[var(--danger)]" />
        </div>

        <h1 className="font-playfair text-xl font-semibold text-[var(--text-primary)] mb-2">
          Произошла ошибка
        </h1>
        <p className="text-sm text-[var(--text-secondary)] mb-6 leading-relaxed">
          Страница столкнулась с проблемой. Попробуйте обновить или вернитесь на главную.
        </p>

        {error.digest && (
          <p className="text-xs text-[var(--text-muted)] font-mono mb-4">
            {error.digest}
          </p>
        )}

        <div className="flex gap-3 justify-center">
          <button onClick={reset} className="ds-btn ds-btn-primary">
            Попробовать снова
          </button>
          <Link href="/" className="ds-btn ds-btn-secondary">
            На главную
          </Link>
        </div>
      </div>
    </div>
  );
}
