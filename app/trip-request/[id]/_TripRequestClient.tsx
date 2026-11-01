'use client';

/**
 * Одна страница поездки (02.11, P0 «связность»): тур, жильё и машина одной
 * историей. Ключи частей — во фрагменте адреса, каждая часть читается тем же
 * /api/requests/status, что и /request-status; согласие и переписка — на
 * странице части (ссылка «открыть»). Подтверждает человек, оплаты нет.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { tripSummary } from '@/lib/trip/trip-summary';
import type { RequestState } from '@/lib/mcp/request-status-schema';

interface Part {
  key: string;
  ok: boolean;
  data?: { state: RequestState; kind: string; tour: string | null; accommodation: string | null; date: string | null; check_out: string | null; participants: number | null; human: string };
  error?: string;
}

const KIND: Record<string, string> = { lead: 'Подбор менеджером Ведара', seat_request: 'Места на тур', stay_request: 'Жильё' };

export function TripRequestClient({ tripId }: { tripId: string | null }) {
  const [parts, setParts] = useState<Part[] | null>(null);
  useEffect(() => {
    const keys = window.location.hash.replace(/^#/, '').split('.').filter((k) => /^[\w-]{16,64}$/.test(k)).slice(0, 6);
    if (!keys.length) { setParts([]); return; }
    Promise.all(keys.map(async (key): Promise<Part> => {
      try {
        const r = await fetch(`/api/requests/status?k=${encodeURIComponent(key)}`, { cache: 'no-store' });
        const j = await r.json();
        return j.success ? { key, ok: true, data: j.data } : { key, ok: false, error: j.error };
      } catch { return { key, ok: false, error: 'Не удалось проверить состояние, обновите страницу через минуту' }; }
    })).then(setParts);
  }, []);

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-2xl font-semibold">Поездка {tripId ?? ''}</h1>
      <p className="mt-2 text-sm text-gray-600">
        Заявка создана. Каждую часть подтверждает человек — оператор тура, владелец жилья или менеджер Ведара свяжется с вами.
        Мгновенного бронирования нет, оплата не через платформу.
      </p>
      {parts === null && <p className="mt-6">Загружаю части поездки…</p>}
      {parts && (() => {
        const sum = tripSummary(parts.map((p) => (p.ok && p.data ? p.data.state : null)));
        const cls = { ok: 'border-green-600', wait: 'border-gray-400', act: 'border-amber-500', bad: 'border-red-500' }[sum.tone];
        return (
          <div className={`mt-6 rounded-lg border-2 p-4 ${cls}`} data-testid="trip-summary">
            <div className="font-medium">{sum.ru}</div>
            <div className="text-xs text-gray-500">{sum.en}</div>
          </div>
        );
      })()}
      <ul className="mt-6 space-y-4">
        {parts?.map((p, i) => (
          <li key={p.key} className="rounded-lg border p-4">
            {p.ok && p.data ? (
              <>
                <div className="font-medium">
                  <span className="mr-2 text-gray-500">{i + 1}/{parts.length}</span>
                  {p.data.accommodation ? `Жильё: ${p.data.accommodation}` : p.data.tour ? `Тур: ${p.data.tour}` : KIND[p.data.kind] ?? 'Заявка'}
                </div>
                <div className="text-sm text-gray-600">
                  {[p.data.date, p.data.check_out && `— ${p.data.check_out}`, p.data.participants && `${p.data.participants} чел.`].filter(Boolean).join(' ')}
                </div>
                <div className="mt-1">{p.data.human}</div>
              </>
            ) : <div className="text-sm">{p.error}</div>}
            <Link className="mt-2 inline-block text-sm underline" href={`/request-status#${p.key}`}>Открыть заявку: согласие и переписка</Link>
          </li>
        ))}
      </ul>
      <p className="mt-8 text-xs text-gray-500">EN: Each part is confirmed by a person; no instant booking, no payment through the platform. ZH: 每一部分由人工确认；无即时预订，平台不收款。</p>
    </main>
  );
}
