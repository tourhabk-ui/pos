'use client';

import { useEffect, useState } from 'react';
import { ClipboardList, CheckCircle, AlertTriangle, Clock } from 'lucide-react';

interface Report {
  id: string;
  is_ok: boolean;
  conditions: string[];
  note: string | null;
  created_at: string;
}

const CONDITION_LABELS: Record<string, string> = {
  trail_ok:      'Тропа проходима',
  trail_blocked: 'Тропа закрыта',
  bears:         'Медведи',
  crowded:       'Многолюдно',
  quiet:         'Безлюдно',
  signal_ok:     'Связь есть',
  signal_none:   'Связи нет',
  access_closed: 'Проход закрыт',
};

function timeAgo(isoStr: string): string {
  const diffMin = Math.round((Date.now() - new Date(isoStr).getTime()) / 60_000);
  if (diffMin < 60)  return `${diffMin} мин назад`;
  if (diffMin < 1440) return `${Math.round(diffMin / 60)} ч назад`;
  return `${Math.round(diffMin / 1440)} д назад`;
}

export default function PlaceFieldReports({ placeId }: { placeId: string }) {
  const [reports, setReports] = useState<Report[]>([]);
  const [loaded, setLoaded]   = useState(false);

  useEffect(() => {
    fetch(`/api/places/${placeId}/safety-report`)
      .then(r => r.json())
      .then((d: { reports: Report[] }) => {
        setReports(d.reports ?? []);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [placeId]);

  if (!loaded || reports.length === 0) return null;

  return (
    <div className="max-w-3xl mx-auto px-4 mt-6">
      <div className="ds-card p-4">
        <div className="flex items-center gap-2 mb-3">
          <ClipboardList size={16} style={{ color: 'var(--ocean)' }} />
          <h3 className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
            Полевые отчёты туристов
          </h3>
          <span className="text-xs px-1.5 py-0.5 rounded-full ml-auto"
            style={{ background: 'var(--bg-hover)', color: 'var(--text-muted)' }}>
            {reports.length} за 7 дней
          </span>
        </div>

        <div className="space-y-3">
          {reports.slice(0, 5).map(r => (
            <div key={r.id} className="flex gap-3">
              <div className="flex-shrink-0 mt-0.5">
                {r.is_ok && r.conditions.length === 0
                  ? <CheckCircle size={15} style={{ color: 'var(--success)' }} />
                  : <AlertTriangle size={15} style={{ color: 'var(--warning)' }} />
                }
              </div>
              <div className="flex-1 min-w-0">
                {r.conditions.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-1">
                    {r.conditions.map(c => (
                      <span key={c} className="text-[11px] px-1.5 py-0.5 rounded"
                        style={{ background: 'var(--bg-hover)', color: 'var(--text-secondary)' }}>
                        {CONDITION_LABELS[c] ?? c}
                      </span>
                    ))}
                  </div>
                )}
                {r.conditions.length === 0 && r.is_ok && (
                  <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>Всё нормально</p>
                )}
                {r.note && (
                  <p className="text-xs mt-0.5 leading-snug" style={{ color: 'var(--text-secondary)' }}>
                    {r.note}
                  </p>
                )}
                <div className="flex items-center gap-1 mt-1" style={{ color: 'var(--text-muted)' }}>
                  <Clock size={10} />
                  <span className="text-[10px]">{timeAgo(r.created_at)}</span>
                </div>
              </div>
            </div>
          ))}
        </div>

        <p className="text-[10px] mt-3 pt-3 border-t" style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}>
          Отчёты присылают туристы с места. Проверяйте актуальность перед выходом.
        </p>
      </div>
    </div>
  );
}
