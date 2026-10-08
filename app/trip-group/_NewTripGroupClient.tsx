'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Users } from 'lucide-react';

/**
 * Завести группу (#2226): только даты поездки. Имён и контактов нет — группа
 * держится на ссылке, которую организатор рассылает сам.
 */
export function NewTripGroupClient() {
  const router = useRouter();
  const [arrival, setArrival] = useState('');
  const [departure, setDeparture] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch('/api/trip-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ arrival_date: arrival, departure_date: departure }),
      });
      const json = await res.json().catch(() => null) as { success?: boolean; error?: string; data?: { id: string } } | null;
      if (!res.ok || !json?.success || !json.data) {
        setError(json?.error ?? 'Не удалось завести группу. Попробуйте ещё раз.');
        return;
      }
      router.push(`/trip-group/${json.data.id}`);
    } catch (err) {
      console.error('[trip-group] группа не заведена', err);
      setError('Не удалось связаться с сервером. Проверьте связь и попробуйте ещё раз.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="ds-page min-h-screen px-4 py-10">
      <div className="mx-auto max-w-xl space-y-6">
        <header className="space-y-2">
          <p className="ds-label flex items-center gap-2"><Users className="w-4 h-4" /> Поездка группой</p>
          <h1 className="font-playfair text-4xl font-bold text-[var(--text-primary)]">Один план на всех</h1>
          <p className="text-[var(--text-secondary)] leading-relaxed">
            Назовите даты и отправьте ссылку попутчикам. Каждый отметит, что хочет и что ему не подходит, —
            планер сведёт пожелания в один маршрут: интересы по голосам, темп и сложность по самому
            слабому участнику. Группа хранится 14 дней.
          </p>
        </header>

        <form onSubmit={submit} className="ds-card p-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="ds-label">Прилёт</span>
              <input type="date" required value={arrival} onChange={(e) => setArrival(e.target.value)} className="ds-input w-full" />
            </label>
            <label className="block">
              <span className="ds-label">Отъезд</span>
              <input type="date" required min={arrival || undefined} value={departure} onChange={(e) => setDeparture(e.target.value)} className="ds-input w-full" />
            </label>
          </div>
          {error && <p role="alert" className="text-sm text-[var(--danger)]">{error}</p>}
          <button type="submit" disabled={loading} className="ds-btn ds-btn-primary w-full">
            {loading ? 'Создаю…' : 'Создать группу'}
          </button>
        </form>
      </div>
    </main>
  );
}
