'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Building2, Check, X, Loader2, AlertCircle, RefreshCw, LogOut, Phone, ClipboardList } from 'lucide-react';
import { formatDateOnly } from '@/lib/dates/date-only';
import { plural } from '@/lib/home/data-freshness';

/**
 * Команда оператора на «Обзоре» гида: приглашения (принять/отклонить),
 * текущий оператор и ближайшие назначения (GET /api/guide/team, /api/guide/groups).
 *
 * Здесь без ПД туриста — только тур, дата и число людей; контакт — в «Группах».
 * Выход из команды — подтверждаемое действие: он снимает гида с будущих броней.
 */
interface Invite { id: string; operatorId: string; operatorName: string | null; createdAt: string }
interface Operator { id: string; name: string | null; phone: string | null }
interface Group { key: string; date: string; tourTitle: string; totalParticipants: number }

export default function GuideTeamPanel() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [operator, setOperator] = useState<Operator | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/guide/team');
      const json = await res.json();
      if (!res.ok || !json.success) {
        setError(json.error || 'Не удалось загрузить приглашения');
        return;
      }
      setOperator(json.data.operator ?? null);
      setInvites(json.data.invites ?? []);
      if (json.data.operator) {
        // Назначения — вторым запросом; его отказ не прячет команду, а
        // называется отдельно (groups = null → «не удалось загрузить»).
        try {
          const g = await fetch('/api/guide/groups');
          const gj = await g.json();
          setGroups(g.ok && gj.success ? (gj.data.groups ?? []) : null);
        } catch {
          setGroups(null);
        }
      } else {
        setGroups([]);
      }
    } catch {
      setError('Сеть недоступна. Приглашения не загружены.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function respond(inviteId: string, action: 'accept' | 'decline') {
    setBusy(inviteId);
    setNotice(null);
    try {
      const res = await fetch('/api/guide/team', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inviteId, action }),
      });
      const json = await res.json();
      setNotice({ ok: res.ok && json.success, text: json.message || json.error || 'Готово' });
      if (res.ok && json.success) await load();
    } catch {
      setNotice({ ok: false, text: 'Сеть недоступна. Ответ не отправлен.' });
    } finally {
      setBusy(null);
    }
  }

  async function leave() {
    setConfirmLeave(false);
    setBusy('leave');
    setNotice(null);
    try {
      const res = await fetch('/api/guide/team', { method: 'DELETE' });
      const json = await res.json();
      setNotice({ ok: res.ok && json.success, text: json.message || json.error || 'Готово' });
      if (res.ok && json.success) await load();
    } catch {
      setNotice({ ok: false, text: 'Сеть недоступна. Выход не выполнен.' });
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="ds-card p-4 flex items-center gap-2 text-sm text-[var(--text-muted)]">
        <Loader2 className="w-4 h-4 animate-spin" /> Команда и приглашения...
      </div>
    );
  }

  if (error) {
    return (
      <div className="ds-card p-4 flex items-start gap-3">
        <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-[var(--danger)]" />
        <div className="flex-1 min-w-0 text-sm">
          <p className="font-medium text-[var(--text-primary)]">{error}</p>
          <p className="text-[var(--text-secondary)] mt-0.5">Мы не знаем, есть ли у вас приглашения.</p>
        </div>
        <button type="button" onClick={() => void load()} className="ds-btn ds-btn-secondary inline-flex items-center gap-1.5 shrink-0">
          <RefreshCw className="w-4 h-4" /> Повторить
        </button>
      </div>
    );
  }

  const upcoming = groups?.slice(0, 3) ?? [];

  return (
    <section className="ds-card p-4 sm:p-5 space-y-4" aria-label="Команда оператора">
      <div className="flex items-start gap-3">
        <span className="flex items-center justify-center w-11 h-11 rounded-full bg-[var(--ocean)]/10 shrink-0">
          <Building2 className="w-[22px] h-[22px] text-[var(--ocean)]" strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          {operator ? (
            <>
              <p className="font-semibold text-[var(--text-primary)]">Вы в команде: {operator.name ?? 'оператор'}</p>
              {operator.phone && (
                <a href={`tel:${operator.phone}`} className="text-sm inline-flex items-center gap-1 text-[var(--ocean)] hover:underline">
                  <Phone className="w-3.5 h-3.5" /> {operator.phone}
                </a>
              )}
            </>
          ) : (
            <>
              <p className="font-semibold text-[var(--text-primary)]">Вы пока не в команде оператора</p>
              <p className="text-sm text-[var(--text-secondary)] mt-0.5">
                Оператор приглашает гида по e-mail его аккаунта. Приглашение появится здесь.
              </p>
            </>
          )}
        </div>
        {operator && (
          <button
            type="button"
            onClick={() => setConfirmLeave(true)}
            disabled={busy !== null}
            className="ds-btn ds-btn-secondary inline-flex items-center gap-1.5 shrink-0 disabled:opacity-50"
          >
            <LogOut className="w-4 h-4" /> Выйти
          </button>
        )}
      </div>

      {confirmLeave && (
        <div className="rounded-lg border border-[var(--warning)]/40 bg-[var(--bg-card)] p-3 space-y-3" role="alertdialog" aria-labelledby="leave-title">
          <p id="leave-title" className="text-sm text-[var(--text-primary)]">
            Выйти из команды? Оператор снимет вас с будущих броней, и контакты туристов станут недоступны.
          </p>
          <div className="flex gap-2">
            <button type="button" onClick={() => setConfirmLeave(false)} className="ds-btn ds-btn-secondary">Не надо</button>
            <button type="button" onClick={() => void leave()} className="ds-btn ds-btn-danger">Выйти из команды</button>
          </div>
        </div>
      )}

      {invites.length > 0 && (
        <div className="space-y-2">
          <p className="ds-label">Приглашения</p>
          {invites.map((inv) => (
            <div key={inv.id} className="flex items-center justify-between gap-3 flex-wrap rounded-lg border border-[var(--border)] px-3 py-2.5">
              <span className="text-sm text-[var(--text-primary)]">{inv.operatorName ?? 'Оператор'} приглашает вас в команду</span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void respond(inv.id, 'accept')}
                  disabled={busy !== null}
                  className="ds-btn ds-btn-primary inline-flex items-center gap-1.5 disabled:opacity-50"
                >
                  {busy === inv.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Принять
                </button>
                <button
                  type="button"
                  onClick={() => void respond(inv.id, 'decline')}
                  disabled={busy !== null}
                  className="ds-btn ds-btn-secondary inline-flex items-center gap-1.5 disabled:opacity-50"
                >
                  <X className="w-4 h-4" /> Отклонить
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {operator && (
        <div className="space-y-2">
          <p className="ds-label">Ближайшие назначения</p>
          {groups === null ? (
            <p className="text-sm text-[var(--danger)]">Не удалось загрузить назначения — откройте «Группы».</p>
          ) : upcoming.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)]">Пока пусто — оператор ещё не назначил вас на брони.</p>
          ) : (
            <>
              {upcoming.map((g) => (
                <div key={g.key} className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-[var(--text-primary)] truncate">{g.tourTitle}</span>
                  <span className="text-[var(--text-secondary)] shrink-0">
                    {formatDateOnly(g.date, { day: 'numeric', month: 'short' })} · {g.totalParticipants} {plural(g.totalParticipants, 'человек', 'человека', 'человек')}
                  </span>
                </div>
              ))}
              <Link href="/hub/guide/groups" className="inline-flex items-center gap-1.5 text-sm text-[var(--accent)] hover:underline">
                <ClipboardList className="w-4 h-4" /> Все группы и контакты
              </Link>
            </>
          )}
        </div>
      )}

      {notice && (
        <p className={`text-sm ${notice.ok ? 'text-[var(--success)]' : 'text-[var(--danger)]'}`}>{notice.text}</p>
      )}
    </section>
  );
}
