'use client';

import { useState, useEffect } from 'react';
import { Bot, CheckCircle, XCircle, RefreshCw, Save } from 'lucide-react';

interface BotStatus {
  configured: boolean;
  token_source: string | null;
  token_tail?: string;
  webhook?: { url: string; pending_update_count: number; last_error_message?: string } | null;
}

export default function TelegramAdminClient() {
  const [status, setStatus]   = useState<BotStatus | null>(null);
  const [token, setToken]     = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving]   = useState(false);
  const [result, setResult]   = useState<{ ok: boolean; msg: string } | null>(null);

  async function loadStatus() {
    setLoading(true);
    try {
      const r = await fetch('/api/admin/telegram');
      if (r.ok) setStatus(await r.json() as BotStatus);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }

  useEffect(() => { loadStatus(); }, []);

  async function handleSave() {
    const tok = token.trim();
    if (!tok) { setResult({ ok: false, msg: 'Введи токен бота' }); return; }

    setSaving(true);
    setResult(null);
    try {
      // Сервер сам вызывает Telegram API (браузер может быть заблокирован)
      const r = await fetch('/api/admin/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: tok }),
      });
      const data = await r.json() as { success: boolean; bot?: { username: string }; webhook_url?: string; error?: string };
      if (data.success) {
        setResult({ ok: true, msg: `Бот @${data.bot?.username} подключён. Webhook: ${data.webhook_url}` });
        setToken('');
        await loadStatus();
      } else {
        setResult({ ok: false, msg: data.error ?? 'Неизвестная ошибка сервера' });
      }
    } catch (err) {
      setResult({ ok: false, msg: `Сетевая ошибка: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setSaving(false);
    }
  }

  async function handleReregister() {
    setSaving(true);
    setResult(null);
    try {
      const r = await fetch('/api/admin/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reregister: true }),
      });
      const data = await r.json() as { success: boolean; webhook_url?: string; bot?: { username: string }; error?: string };
      setResult({ ok: data.success, msg: data.success ? `Webhook зарегистрирован: ${data.webhook_url}` : (data.error ?? 'Ошибка') });
      if (data.success) await loadStatus();
    } catch (err) {
      setResult({ ok: false, msg: `Ошибка: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setSaving(false);
    }
  }

  const webhookOk = status?.webhook?.url?.includes('vedarai.ru');

  return (
    <div className="ds-page max-w-lg mx-auto py-8 space-y-6">
      <div className="flex items-center gap-3">
        <Bot className="w-6 h-6 text-[var(--ocean)]" />
        <h1 className="ds-h1">Telegram бот</h1>
      </div>

      <div className="ds-card p-5 space-y-3">
        <div className="flex items-center justify-between">
          <span className="ds-label">Статус</span>
          <button onClick={loadStatus} disabled={loading} className="ds-btn p-1">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {!status ? (
          <div className="ds-skeleton h-12 rounded" />
        ) : !status.configured ? (
          <div className="flex items-center gap-2 text-[var(--danger)]">
            <XCircle className="w-4 h-4" />
            <span className="text-sm">Токен не настроен</span>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-[var(--success)]">
              <CheckCircle className="w-4 h-4" />
              <span className="text-sm">Токен задан (…{status.token_tail})</span>
              <span className="text-xs text-[var(--text-muted)]">{status.token_source}</span>
            </div>
            {status.webhook ? (
              <div className={`text-xs rounded p-2 ${webhookOk ? 'bg-[var(--success)]/10 text-[var(--success)]' : 'bg-[var(--warning)]/10 text-[var(--warning)]'}`}>
                Webhook: {status.webhook.url}
                {status.webhook.last_error_message && (
                  <div className="mt-1 text-[var(--danger)]">Ошибка: {status.webhook.last_error_message}</div>
                )}
              </div>
            ) : (
              <div className="text-xs text-[var(--warning)]">Webhook не зарегистрирован</div>
            )}
          </div>
        )}
      </div>

      <div className="ds-card p-5 space-y-4">
        <p className="text-sm text-[var(--text-secondary)]">
          Вставь новый токен из @BotFather → нажми «Подключить». Сервер сам зарегистрирует webhook.
        </p>
        <div className="space-y-2">
          <label className="ds-label">Токен бота</label>
          <input
            className="ds-input w-full font-mono text-sm"
            placeholder="123456789:AAG0..."
            value={token}
            onChange={e => setToken(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        {result && (
          <div className={`text-sm rounded p-3 break-all ${result.ok ? 'bg-[var(--success)]/10 text-[var(--success)]' : 'bg-[var(--danger)]/10 text-[var(--danger)]'}`}>
            {result.msg}
          </div>
        )}

        <button
          className="ds-btn ds-btn-primary w-full flex items-center justify-center gap-2"
          onClick={handleSave}
          disabled={saving || !token.trim()}
        >
          {saving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {saving ? 'Подключаем...' : 'Подключить бота'}
        </button>

        {status?.configured && (
          <button
            className="ds-btn ds-btn-secondary w-full"
            onClick={handleReregister}
            disabled={saving}
          >
            Перерегистрировать webhook (текущий токен)
          </button>
        )}
      </div>

      <p className="text-xs text-[var(--text-muted)] text-center">
        После подключения напиши боту /start — должен ответить.
      </p>
    </div>
  );
}
