'use client';

import { useCallback, useEffect, useState } from 'react';
import { UserPlus, Loader2, AlertCircle, RefreshCw, Mail, X } from 'lucide-react';

/**
 * Приглашения гидов в команду (GET/POST/DELETE /api/operator/guides/invites).
 *
 * Гид приглашается по e-mail ЕГО аккаунта на платформе; принимает или
 * отклоняет в своём кабинете. Принятое приглашение — единственный путь, по
 * которому гид попадает в список «Гиды» ниже (partners.guide_operator_id).
 */
interface Invite {
  id: string;
  status: 'pending' | 'accepted' | 'declined' | 'revoked' | 'left';
  guideId: string;
  guideName: string;
  createdAt: string;
  respondedAt: string | null;
}

const STATUS_LABEL: Record<Invite['status'], string> = {
  pending: 'Ждёт ответа',
  accepted: 'Принято',
  declined: 'Отклонено',
  revoked: 'Отозвано',
  left: 'Гид вышел',
};

const STATUS_CLS: Record<Invite['status'], string> = {
  pending: 'bg-[var(--warning)]/15 text-[var(--warning)]',
  accepted: 'bg-[var(--success)]/15 text-[var(--success)]',
  declined: 'bg-[var(--text-muted)]/15 text-[var(--text-muted)]',
  revoked: 'bg-[var(--text-muted)]/15 text-[var(--text-muted)]',
  left: 'bg-[var(--text-muted)]/15 text-[var(--text-muted)]',
};

export default function GuideInvites() {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/operator/guides/invites');
      const json = await res.json();
      if (!res.ok || !json.success) {
        setError(json.error || 'Не удалось загрузить приглашения');
        return;
      }
      setInvites(json.data ?? []);
    } catch {
      setError('Сеть недоступна. Приглашения не загружены.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setNotice(null);
    try {
      const res = await fetch('/api/operator/guides/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      const json = await res.json();
      const ok = res.ok && json.success;
      setNotice({ ok, text: ok ? `Приглашение отправлено: ${json.data.guideName}` : (json.error || 'Не удалось отправить приглашение') });
      if (ok) {
        setEmail('');
        await load();
      }
    } catch {
      setNotice({ ok: false, text: 'Сеть недоступна. Приглашение не отправлено.' });
    } finally {
      setSending(false);
    }
  }

  async function revoke(inv: Invite) {
    setBusyId(inv.id);
    setNotice(null);
    try {
      const res = await fetch('/api/operator/guides/invites', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inviteId: inv.id }),
      });
      const json = await res.json();
      setNotice({ ok: res.ok && json.success, text: json.message || json.error || 'Готово' });
      await load();
    } catch {
      setNotice({ ok: false, text: 'Сеть недоступна. Приглашение не отозвано.' });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4 mb-6 space-y-4" aria-label="Пригласить гида">
      <form onSubmit={invite} className="flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[220px]">
          <label htmlFor="guide-invite-email" className="ds-label">Пригласить гида в команду</label>
          <div className="relative">
            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
            <input
              id="guide-invite-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="e-mail аккаунта гида"
              className="w-full min-h-[44px] pl-10 pr-4 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30"
            />
          </div>
        </div>
        <button type="submit" disabled={sending} className="ds-btn ds-btn-primary inline-flex items-center gap-1.5 disabled:opacity-50">
          {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />} Пригласить
        </button>
      </form>
      <p className="text-xs text-[var(--text-muted)]">
        Гид должен быть зарегистрирован на платформе как гид. Приглашение он примет в своём кабинете.
      </p>

      {notice && (
        <p className={`text-sm ${notice.ok ? 'text-[var(--success)]' : 'text-[var(--danger)]'}`}>{notice.text}</p>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <Loader2 className="w-4 h-4 animate-spin" /> Приглашения...
        </div>
      ) : error ? (
        <div className="flex items-start gap-3 text-sm">
          <AlertCircle className="w-4 h-4 mt-0.5 text-[var(--danger)] shrink-0" />
          <p className="flex-1 text-[var(--text-primary)]">{error}</p>
          <button type="button" onClick={() => void load()} className="ds-btn ds-btn-secondary inline-flex items-center gap-1.5 shrink-0">
            <RefreshCw className="w-4 h-4" /> Повторить
          </button>
        </div>
      ) : invites.length > 0 ? (
        <ul className="divide-y divide-[var(--border)]">
          {invites.map((inv) => (
            <li key={inv.id} className="flex items-center justify-between gap-3 py-2.5 flex-wrap">
              <div className="min-w-0">
                <p className="text-sm text-[var(--text-primary)]">{inv.guideName}</p>
                <p className="text-xs text-[var(--text-muted)]">{new Date(inv.createdAt).toLocaleDateString('ru-RU')}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_CLS[inv.status]}`}>{STATUS_LABEL[inv.status]}</span>
                {inv.status === 'pending' && (
                  <button
                    type="button"
                    onClick={() => void revoke(inv)}
                    disabled={busyId === inv.id}
                    className="min-h-[44px] px-3 rounded-lg text-sm border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-50 transition-colors inline-flex items-center gap-1.5"
                  >
                    {busyId === inv.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <X className="w-4 h-4" />} Отозвать
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
