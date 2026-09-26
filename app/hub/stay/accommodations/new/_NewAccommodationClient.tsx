'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Home } from 'lucide-react';
import AccommodationCreateForm from '@/components/hub/AccommodationCreateForm';

/**
 * «Добавить объект» из кабинета жилья. До 26.09 кнопка вела в онбординг,
 * а онбординг уводит прошедших его обратно в /hub/stay — второй объект
 * завести было негде. Форма та же, что в онбординге.
 */
export default function NewAccommodationClient() {
  const router = useRouter();
  return (
    <div className="p-5 lg:p-6 space-y-4 max-w-2xl">
      <Link
        href="/hub/stay/accommodations"
        className="inline-flex items-center gap-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
      >
        <ArrowLeft className="w-3.5 h-3.5" /> Мои объекты
      </Link>
      <div className="flex items-center gap-2.5">
        <Home className="w-4 h-4 text-[var(--text-muted)]" />
        <h1 className="text-sm font-semibold text-[var(--text-primary)] tracking-tight">Новый объект</h1>
      </div>
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-5">
        <AccommodationCreateForm
          onCreated={() => router.push('/hub/stay/accommodations')}
          secondary={{ label: 'Отмена', onClick: () => router.push('/hub/stay/accommodations') }}
        />
      </div>
    </div>
  );
}
