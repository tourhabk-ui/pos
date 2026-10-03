import type { Metadata } from 'next';
import { Suspense } from 'react';
import { Loader2 } from 'lucide-react';
import WatchClient from './WatchClient';

export const metadata: Metadata = {
  title: 'Контроль выхода',
  robots: 'noindex, nofollow',
};

export default function WatchPage() {
  return (
    <Suspense fallback={
      <div className="min-h-[100dvh] bg-[var(--bg-primary)] flex items-center justify-center p-6">
        <Loader2 className="w-8 h-8 animate-spin text-[var(--accent)]" />
      </div>
    }>
      <WatchClient />
    </Suspense>
  );
}
