'use client';

import { useCallback, useEffect, useState } from 'react';
import { Protected } from '@/components/auth/Protected';
import { BUSINESS_TYPES, type BusinessType } from '@/lib/partners/application';

interface Application {
  at: string; business_type: BusinessType; contact_name: string; contact: string;
  wants: string | null; utm?: Record<string, string>; test?: boolean;
}
interface Row {
  id: string; name: string; source: string | null; status: string; notes: string | null;
  details: { applications?: Application[] }; created_at: string;
}

const STATUSES = [
  { v: 'new', l: 'Новая' }, { v: 'contacted', l: 'Связались' },
  { v: 'agreed', l: 'Договорились' }, { v: 'declined', l: 'Отказ' },
];

export default function PartnerApplicationsClient() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    fetch('/api/admin/partner-prospects')
      .then(r => r.json())
      .then((d: { success?: boolean; data?: Row[]; error?: string }) => {
        if (!d.success) throw new Error(d.error ?? 'Ошибка');
        setRows((d.data ?? []).filter(r => (r.details.applications?.length ?? 0) > 0));
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Ошибка'));
  }, []);
  useEffect(load, [load]);

  async function setStatus(id: string, status: string) {
    await fetch('/api/admin/partner-prospects', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, status }),
    });
    load();
  }

  return (
    <Protected roles={['admin']}>
      <div className="max-w-4xl mx-auto p-4 space-y-4">
        <h1 className="text-2xl font-bold">Заявки на подключение (/partner)</h1>
        {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
        {rows === null && !error && <p>Загрузка…</p>}
        {rows?.length === 0 && <p className="text-[var(--text-muted)]">Заявок пока нет.</p>}
        {rows?.map(r => {
          const apps = r.details.applications ?? [];
          const last = apps[apps.length - 1];
          return (
            <div key={r.id} className="ds-card p-4 bg-white space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="font-semibold">{last?.test ? '[ТЕСТ] ' : ''}{r.name}</div>
                <select value={r.status} onChange={e => setStatus(r.id, e.target.value)} className="border rounded px-2 py-1 text-sm">
                  {STATUSES.map(s => <option key={s.v} value={s.v}>{s.l}</option>)}
                </select>
              </div>
              {apps.map((a, i) => (
                <div key={i} className="text-sm text-[var(--text-secondary)]">
                  {new Date(a.at).toLocaleString('ru-RU')} · {BUSINESS_TYPES[a.business_type] ?? a.business_type}
                  {' · '}{a.contact_name}, {a.contact}
                  {a.utm?.utm_source ? ` · ${a.utm.utm_source}` : ''}
                  {a.wants ? <div className="mt-1">{a.wants}</div> : null}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </Protected>
  );
}
