'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ShieldCheck, ShieldAlert, Clock, MapPin, Phone, Plus, CheckCircle2, RefreshCw,
} from 'lucide-react';

interface Registration {
  id: string;
  route_name: string;
  region: string | null;
  start_date: string;
  end_date: string;
  expected_return_at: string | null;
  checkin_confirmed_at: string | null;
  completed_at: string | null;
  group_size: number | null;
  leader_phone: string;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
}

function controlTime(r: Registration): Date {
  return new Date(r.expected_return_at ?? `${r.end_date}T23:59:00`);
}

function fmt(d: Date): string {
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export default function SafetyClient() {
  const [regs, setRegs] = useState<Registration[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/tourist/safety-registrations');
      const d = await res.json();
      if (d.success) setRegs(d.data);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const markReturned = async (r: Registration) => {
    if (busyId) return;
    setBusyId(r.id);
    try {
      const res = await fetch('/api/safety/return', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ registration_id: r.id, leader_phone: r.leader_phone }),
      });
      const d = await res.json();
      if (d.success) await load();
      else alert(d.error || 'Не удалось отметить возвращение');
    } catch {
      alert('Сеть недоступна. Попробуйте ещё раз.');
    } finally {
      setBusyId(null);
    }
  };

  const active = regs.filter((r) => !r.completed_at);
  const done = regs.filter((r) => r.completed_at);
  const now = Date.now();

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 lg:py-8 space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="font-playfair text-2xl sm:text-3xl font-bold text-[var(--text-primary)]">Контрольный срок</h1>
          <p className="text-sm text-[var(--text-secondary)] mt-1 max-w-xl">
            Зарегистрируйте маршрут и укажите время возврата. Если вы не отметите возвращение
            вовремя, платформа поднимет тревогу по вашему экстренному контакту и МЧС Камчатки.
          </p>
        </div>
        <button onClick={load} className="ds-btn flex items-center gap-1.5 px-3 py-2 text-sm shrink-0" aria-label="Обновить">
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      <Link
        href="/register"
        className="flex items-center justify-center gap-2 w-full px-4 py-3 rounded-lg bg-[var(--accent)] text-white font-medium hover:opacity-90 transition-opacity"
      >
        <Plus className="w-4 h-4" /> Зарегистрировать маршрут
      </Link>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="w-8 h-8 border-2 border-[var(--border)] border-t-[var(--accent)] rounded-full animate-spin" />
        </div>
      ) : (
        <>
          {/* Активные контрольные сроки */}
          <section className="space-y-3">
            <p className="ds-label">Активные</p>
            {active.length === 0 ? (
              <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-5 py-10 text-center">
                <ShieldCheck className="w-8 h-8 text-[var(--text-muted)] mx-auto mb-3" />
                <p className="text-sm text-[var(--text-muted)]">Нет активных регистраций. Перед выходом на маршрут — зарегистрируйтесь выше.</p>
              </div>
            ) : (
              active.map((r) => {
                const ct = controlTime(r);
                const overdue = now > ct.getTime();
                return (
                  <div key={r.id} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-5">
                    <div className="flex items-start justify-between gap-3 mb-3">
                      <div className="min-w-0">
                        <h2 className="font-semibold text-[var(--text-primary)] truncate">{r.route_name}</h2>
                        {r.region && (
                          <p className="text-xs text-[var(--text-muted)] flex items-center gap-1 mt-0.5">
                            <MapPin className="w-3 h-3" /> {r.region}
                          </p>
                        )}
                      </div>
                      <span className={`shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium ${
                        overdue
                          ? 'bg-[var(--danger)]/10 text-[var(--danger)]'
                          : 'bg-[var(--success)]/10 text-[var(--success)]'
                      }`}>
                        {overdue ? <ShieldAlert className="w-3.5 h-3.5" /> : <ShieldCheck className="w-3.5 h-3.5" />}
                        {overdue ? 'Просрочен' : 'Активен'}
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5 text-sm text-[var(--text-secondary)] mb-3">
                      <Clock className="w-4 h-4 text-[var(--accent)]" />
                      Вернуться до: <span className="font-medium text-[var(--text-primary)]">{fmt(ct)}</span>
                    </div>

                    {r.emergency_contact_name && (
                      <p className="text-xs text-[var(--text-muted)] flex items-center gap-1 mb-4">
                        <Phone className="w-3 h-3" /> Контакт: {r.emergency_contact_name}
                        {r.emergency_contact_phone ? ` · ${r.emergency_contact_phone}` : ''}
                      </p>
                    )}

                    <button
                      onClick={() => markReturned(r)}
                      disabled={busyId === r.id}
                      className="flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-lg bg-[var(--success)]/10 text-[var(--success)] font-medium hover:bg-[var(--success)]/20 transition-colors disabled:opacity-60"
                    >
                      <CheckCircle2 className="w-4 h-4" /> {busyId === r.id ? '…' : 'Я вернулся'}
                    </button>
                  </div>
                );
              })
            )}
          </section>

          {/* Завершённые */}
          {done.length > 0 && (
            <section className="space-y-2">
              <p className="ds-label">Завершённые</p>
              <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg divide-y divide-[var(--border)]">
                {done.slice(0, 10).map((r) => (
                  <div key={r.id} className="flex items-center gap-3 px-5 py-3">
                    <CheckCircle2 className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
                    <span className="text-sm text-[var(--text-secondary)] flex-1 truncate">{r.route_name}</span>
                    <span className="text-xs text-[var(--text-muted)]">{fmt(controlTime(r))}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
