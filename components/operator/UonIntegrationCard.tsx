'use client';

import { useState, useEffect, useCallback } from 'react';
import { Link2, CheckCircle, Loader2, AlertCircle, ShieldCheck, Unlink } from 'lucide-react';

interface UonStatus {
  connected: boolean;
  keyMask: string | null;
  companyId: number | null;
}

/**
 * Карточка подключения оператора к U-ON.Travel CRM.
 * Оператор вводит свой API-ключ → брони с Ведар автоматически создают заявку
 * в его U-ON. Полный ключ наружу не отдаётся (только маска ••••XXXX).
 */
export default function UonIntegrationCard() {
  const [status, setStatus] = useState<UonStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [apiKey, setApiKey] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/hub/operator/integrations/uon');
      const data = await res.json() as { success?: boolean; data?: UonStatus };
      if (data.success && data.data) {
        setStatus(data.data);
        setCompanyId(data.data.companyId != null ? String(data.data.companyId) : '');
      }
    } catch {
      // тихо — покажем как «не подключено»
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    setSaving(true);
    setFeedback(null);
    try {
      const body: { apiKey?: string; companyId?: number | null } = {};
      if (apiKey.trim()) body.apiKey = apiKey.trim();
      body.companyId = companyId.trim() ? Number(companyId.trim()) : null;

      const res = await fetch('/api/hub/operator/integrations/uon', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || !data.success) throw new Error(data.error ?? 'Ошибка сохранения');
      setFeedback({ ok: true, msg: 'Сохранено. Новые брони будут попадать в ваш U-ON.' });
      setApiKey('');
      await load();
    } catch (err) {
      setFeedback({ ok: false, msg: err instanceof Error ? err.message : 'Ошибка сети' });
    } finally {
      setSaving(false);
    }
  };

  const disconnect = async () => {
    setSaving(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/hub/operator/integrations/uon', { method: 'DELETE' });
      const data = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || !data.success) throw new Error(data.error ?? 'Ошибка отключения');
      setFeedback({ ok: true, msg: 'Интеграция отключена.' });
      setApiKey('');
      await load();
    } catch (err) {
      setFeedback({ ok: false, msg: err instanceof Error ? err.message : 'Ошибка сети' });
    } finally {
      setSaving(false);
    }
  };

  const connected = status?.connected ?? false;

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <div className="p-3 bg-[var(--bg-hover)] rounded-md">
            <Link2 className="w-8 h-8 text-[var(--ocean)]" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-[var(--text-primary)]">U-ON.Travel CRM</h2>
              {loading ? (
                <Loader2 className="w-4 h-4 animate-spin text-[var(--text-muted)]" />
              ) : connected ? (
                <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-[var(--success)]/10 text-[var(--success)]">
                  <CheckCircle className="w-3.5 h-3.5" />Подключено
                </span>
              ) : (
                <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-[var(--warning)]/10 text-[var(--warning)]">
                  <AlertCircle className="w-3.5 h-3.5" />Не подключено
                </span>
              )}
            </div>
            <p className="text-[var(--text-muted)] text-sm mt-1 max-w-xl">
              Брони с Ведар будут автоматически создавать заявку в вашей CRM U-ON.
              {connected && status?.keyMask && (
                <> Текущий ключ: <span className="font-mono text-[var(--text-secondary)]">{status.keyMask}</span>.</>
              )}
            </p>
          </div>
        </div>
      </div>

      {/* Форма */}
      <div className="mt-5 grid gap-3 sm:grid-cols-2 max-w-xl">
        <label className="block sm:col-span-2">
          <span className="ds-label">API-ключ U-ON {connected && <span className="text-[var(--text-muted)]">(оставьте пустым, чтобы не менять)</span>}</span>
          <input
            type="password"
            autoComplete="off"
            className="ds-input w-full font-mono"
            placeholder={connected ? '••••••••' : 'Вставьте ключ из U-ON'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="ds-label">Company ID (необязательно)</span>
          <input
            type="number"
            className="ds-input w-full"
            placeholder="напр. 45820"
            value={companyId}
            onChange={(e) => setCompanyId(e.target.value)}
          />
        </label>
      </div>

      <div className="mt-4 flex items-center gap-3 flex-wrap">
        <button
          onClick={save}
          disabled={saving || (!apiKey.trim() && !companyId.trim())}
          className="ds-btn ds-btn-primary flex items-center gap-2 disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
          Сохранить
        </button>
        {connected && (
          <button
            onClick={disconnect}
            disabled={saving}
            className="ds-btn ds-btn-secondary flex items-center gap-2 disabled:opacity-50"
          >
            <Unlink className="w-4 h-4" />Отключить
          </button>
        )}
        {feedback && (
          <span className="flex items-center gap-1.5 text-sm" style={{ color: feedback.ok ? 'var(--success)' : 'var(--danger)' }}>
            {feedback.ok ? <CheckCircle className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
            {feedback.msg}
          </span>
        )}
      </div>

      {/* Где взять ключ + безопасность */}
      <div className="mt-4 p-3 rounded-md bg-[var(--bg-hover)] text-xs text-[var(--text-muted)] leading-relaxed max-w-xl">
        <p className="flex items-start gap-1.5">
          <ShieldCheck className="w-4 h-4 mt-0.5 flex-shrink-0 text-[var(--ocean)]" />
          Ключ берётся в кабинете U-ON: <span className="text-[var(--text-secondary)]">Настройки → Интеграции → API</span>. Он хранится на сервере и наружу не показывается — только последние 4 символа.
        </p>
      </div>
    </div>
  );
}
