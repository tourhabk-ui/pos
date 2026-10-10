'use client';

/**
 * «Свой ИИ-агент» — ключи MCP партнёра к его CRM (CRM 1д-2, #2325).
 *
 * Партнёр выпускает ключ и отдаёт его своему агенту (Claude, ChatGPT, любой
 * клиент MCP): агент видит те же инструменты CRM, что Кузьмич в чате
 * партнёра, — клиентов подписью «Анна П.», без телефонов и почт. Ключ
 * показывается один раз, по умолчанию — только чтение, отзывается здесь же.
 */
import { useCallback, useState } from 'react';
import { Bot, Copy, KeyRound } from 'lucide-react';
import type { AgentKeyItem } from '@/lib/crm/agent-key-item';
import { CRM_KEYS_API, PARTNER_MCP_PATH } from './api';

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; items: AgentKeyItem[]; maxActive: number }
  | { kind: 'error'; message: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function errorOf(json: unknown, fallback: string): string {
  return isRecord(json) && typeof json.error === 'string' ? json.error : fallback;
}

function when(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString('ru-RU', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kamchatka',
  });
}

export function AgentKeysPanel() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<LoadState>({ kind: 'idle' });
  const [label, setLabel] = useState('');
  const [canWrite, setCanWrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<{ key: string; label: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [origin, setOrigin] = useState('');

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const res = await fetch(CRM_KEYS_API);
      const json: unknown = await res.json().catch(() => null);
      const data = isRecord(json) && isRecord(json.data) ? json.data : null;
      if (res.ok && data && Array.isArray(data.items)) {
        setState({ kind: 'ready', items: data.items as AgentKeyItem[], maxActive: typeof data.max_active === 'number' ? data.max_active : 5 });
      } else {
        setState({ kind: 'error', message: errorOf(json, 'Не удалось загрузить ключи, попробуйте позже') });
      }
    } catch {
      setState({ kind: 'error', message: 'Нет связи с сервером — ключи не загружены' });
    }
  }, []);

  // Ключи грузятся при первом раскрытии — по нажатию, а не эффектом: закрытая
  // панель на «Задачах» в базу не ходит.
  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && state.kind === 'idle') {
      setOrigin(window.location.origin);
      void load();
    }
  }

  async function create() {
    setBusy(true);
    setFormError(null);
    try {
      const res = await fetch(CRM_KEYS_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, can_write: canWrite }),
      });
      const json: unknown = await res.json().catch(() => null);
      const data = isRecord(json) && isRecord(json.data) ? json.data : null;
      if (res.ok && data && typeof data.key === 'string') {
        setFresh({ key: data.key, label });
        setCopied(false);
        setLabel('');
        setCanWrite(false);
        await load();
      } else {
        setFormError(errorOf(json, 'Не удалось выпустить ключ, попробуйте позже'));
      }
    } catch {
      setFormError('Нет связи с сервером — ключ не выпущен');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setBusy(true);
    try {
      const res = await fetch(`${CRM_KEYS_API}/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) {
        const json: unknown = await res.json().catch(() => null);
        setFormError(errorOf(json, 'Не удалось отозвать ключ, попробуйте позже'));
      }
      setConfirmRevoke(null);
      await load();
    } catch {
      setFormError('Нет связи с сервером — ключ не отозван');
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const endpoint = `${origin}${PARTNER_MCP_PATH}`;
  const active = state.kind === 'ready' ? state.items.filter((k) => !k.revoked_at) : [];

  return (
    <section aria-label="Свой ИИ-агент" className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="w-full flex items-center gap-2.5 p-4 text-left transition-colors duration-200 hover:bg-[var(--bg-hover)] rounded-lg"
      >
        <Bot className="w-4 h-4 text-[var(--ocean)]" />
        <span className="text-sm font-semibold text-[var(--text-primary)]">Свой ИИ-агент (MCP)</span>
        <span className="text-xs text-[var(--text-muted)]">подключить Claude, ChatGPT или другого агента к своей CRM</span>
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-4">
          <p className="text-xs text-[var(--text-secondary)]">
            Агент видит ваших клиентов, входящие и задачи — клиентов подписью вроде «Анна П.», без телефонов и почт.
            Ключ показывается один раз; по умолчанию — только чтение. Ненужный ключ отзовите: он перестанет работать сразу.
          </p>

          {fresh && (
            <div role="status" className="space-y-2 rounded-lg border border-[var(--warning)] p-3">
              <p className="text-xs font-semibold text-[var(--text-primary)]">
                Ключ «{fresh.label}» — скопируйте сейчас, второй раз его не показать
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 min-w-0 break-all text-xs text-[var(--text-primary)] bg-[var(--bg-hover)] rounded-lg px-2 py-1.5">{fresh.key}</code>
                <button type="button" onClick={() => void copy(fresh.key)} className="ds-btn ds-btn-secondary" aria-label="Скопировать ключ">
                  <Copy className="w-4 h-4" />
                </button>
              </div>
              {copied && <p className="text-xs text-[var(--success)]">Скопировано</p>}
              <p className="text-xs text-[var(--text-secondary)]">
                Адрес сервера MCP: <code className="break-all">{endpoint}</code>, заголовок{' '}
                <code>Authorization: Bearer {'<ключ>'}</code>.
              </p>
              <button type="button" onClick={() => setFresh(null)} className="ds-btn ds-btn-secondary">Я сохранил ключ</button>
            </div>
          )}

          <form
            onSubmit={(e) => { e.preventDefault(); void create(); }}
            className="space-y-2"
            aria-label="Новый ключ"
          >
            <div className="flex gap-2 flex-wrap">
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={60}
                placeholder="Название, например «Claude на ноутбуке»"
                aria-label="Название ключа"
                className="ds-input flex-1 min-w-[12rem]"
              />
              <button
                type="submit"
                disabled={busy || !label.trim() || (state.kind === 'ready' && active.length >= state.maxActive)}
                className="ds-btn ds-btn-primary"
              >
                <KeyRound className="w-4 h-4" /> Выпустить ключ
              </button>
            </div>
            <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
              <input type="checkbox" checked={canWrite} onChange={(e) => setCanWrite(e.target.checked)} />
              Разрешить запись: заметки, звонки, задачи и их выполнение
            </label>
            {formError && <p role="alert" className="text-xs text-[var(--danger)]">{formError}</p>}
          </form>

          {state.kind === 'loading' && <div className="ds-skeleton h-12 rounded-lg" />}
          {state.kind === 'error' && (
            <p className="text-xs text-[var(--warning)]">
              {state.message} <button type="button" onClick={() => void load()} className="underline">Повторить</button>
            </p>
          )}
          {state.kind === 'ready' && (
            state.items.length === 0 ? (
              <p className="text-xs text-[var(--text-muted)]">Ключей пока нет.</p>
            ) : (
              <ul className="space-y-2">
                {state.items.map((k) => (
                  <li key={k.id} className={`rounded-lg border border-[var(--border)] p-3 space-y-1 ${k.revoked_at ? 'opacity-60' : ''}`}>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm text-[var(--text-primary)]">{k.label}</span>
                      <code className="text-xs text-[var(--text-muted)]">{k.key_prefix}…</code>
                      <span className="ds-badge">{k.can_write ? 'чтение и запись' : 'только чтение'}</span>
                      {!k.revoked_at && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setConfirmRevoke(confirmRevoke === k.id ? null : k.id)}
                          className="ml-auto text-xs text-[var(--text-muted)] hover:text-[var(--danger)] transition-colors duration-200"
                        >
                          Отозвать
                        </button>
                      )}
                    </div>
                    <p className="text-xs text-[var(--text-muted)]">
                      Выпущен {when(k.created_at)} ·{' '}
                      {k.revoked_at
                        ? `отозван ${when(k.revoked_at)}`
                        : k.last_used_at ? `агент заходил ${when(k.last_used_at)}` : 'агент ещё не заходил'}
                    </p>
                    {confirmRevoke === k.id && (
                      <div className="flex items-center gap-2 flex-wrap text-xs">
                        <span className="text-[var(--text-secondary)]">Отозвать ключ? Агент с ним больше не войдёт.</span>
                        <button type="button" disabled={busy} onClick={() => void revoke(k.id)} className="ds-btn ds-btn-danger">Отозвать</button>
                        <button type="button" disabled={busy} onClick={() => setConfirmRevoke(null)} className="ds-btn ds-btn-secondary">Отмена</button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )
          )}
        </div>
      )}
    </section>
  );
}
