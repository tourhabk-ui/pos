import type { Metadata } from 'next';
import { Suspense } from 'react';
import CheckinOkClient from './CheckinOkClient';
import { Loader2 } from 'lucide-react';

export const metadata: Metadata = {
  title: 'Мы на связи — Tourhab',
  robots: 'noindex, nofollow',
};

export default function CheckinOkPage() {
  return (
    <Suspense fallback={
      <div className="min-h-[100dvh] bg-[var(--bg-primary)] text-[var(--text-primary)] flex items-center justify-center p-6">
        <Loader2 className="w-8 h-8 animate-spin text-[var(--accent)]" />
      </div>
    }>
      <CheckinOkClient />
    </Suspense>
  );
}
