'use client';

import { useState, useEffect } from 'react';
import { Bot, CheckCircle, XCircle, RefreshCw, Save } from 'lucide-react';

const APP_URL = 'https://vedarai.ru';
const WEBHOOK_PATH = '/api/telegram/kuzmich';

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
    } catch { /* сетевая ошибка */ }
    finally { setLoading(false); }
  }

  useEffect(() => { loadStatus(); }, []);

  async function handleSave() {
    const tok = token.trim();
    if (!tok) { setResult({ ok: false, msg: 'Введи токен бота' }); return; }

    setSaving(true);
    setResult(null);
    try {
      // 1. Проверяем токен прямо из браузера (браузер точно достучится до Telegram)
      const meRes = await fetch(`https://api.telegram.org/bot${tok}/getMe`);
      const me = await meRes.json() as { ok: boolean; result?: { username: string; first_name: string }; description?: string };
      if (!me.ok) {
        setResult({ ok: false, msg: `Неверный токен: ${me.description ?? 'ошибка Telegram'}` });
        return;
      }

      // 2. Регистрируем webhook прямо из браузера
      const webhookUrl = `${APP_URL}${WEBHOOK_PATH}`;
      const whRes = await fetch(`https://api.telegram.org/bot${tok}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: webhookUrl, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true }),
      });
      const wh = await whRes.json() as { ok: boolean; description?: string };
      if (!wh.ok) {
        setResult({ ok: false, msg: `Webhook не зарегистрирован: ${wh.description}` });
        return;
      }

      // 3. Сохраняем токен в БД (чтобы сервер мог отвечать)
      const saveRes = await fetch('/api/admin/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: tok, skip_telegram: true }),
      });
      const saved = await saveRes.json() as { success: boolean; error?: string };

      if (saved.success) {
        setResult({ ok: true, msg: `Бот @${me.result?.username} подключён. Webhook: ${webhookUrl}` });
        setToken('');
        await loadStatus();
      } else {
        setResult({ ok: false, msg: `Webhook OK, но токен не сохранён в БД: ${saved.error}. Добавь TELEGRAM_KUZMICH_BOT_TOKEN в Timeweb.` });
      }
    } catch (err) {
      setResult({ ok: false, msg: `Ошибка: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setSaving(false);
    }
  }

  async function handleReregister() {
    setSaving(true);
    setResult(null);
    try {
      // Берём токен из env через сервер — просим сервер вернуть его (tail) и перерегистрировать через браузер
      // Сначала получим актуальный токен из статуса — но у нас только tail. Нужно спросить сервер.
      const r = await fetch('/api/admin/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reregister: true }),
      });
      const data = await r.json() as { success: boolean; webhook_url?: string; error?: string; token?: string };

      if (data.token) {
        // Сервер вернул токен — регистрируем из браузера
        const webhookUrl = `${APP_URL}${WEBHOOK_PATH}`;
        const whRes = await fetch(`https://api.telegram.org/bot${data.token}/setWebhook`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: webhookUrl, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true }),
        });
        const wh = await whRes.json() as { ok: boolean; description?: string };
        setResult({ ok: wh.ok, msg: wh.ok ? `Webhook зарегистрирован: ${webhookUrl}` : `Ошибка: ${wh.description}` });
        if (wh.ok) await loadStatus();
      } else {
        setResult({ ok: data.success, msg: data.error ?? data.webhook_url ?? 'Готово' });
      }
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

      {/* Статус */}
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

      {/* Форма */}
      <div className="ds-card p-5 space-y-4">
        <p className="text-sm text-[var(--text-secondary)]">
          Вставь токен из @BotFather → нажми «Подключить». Webhook регистрируется прямо из браузера.
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
            Перерегистрировать webhook (токен из env)
          </button>
        )}
      </div>

      <p className="text-xs text-[var(--text-muted)] text-center">
        После подключения напиши боту /start — должен ответить.
      </p>
    </div>
  );
}
