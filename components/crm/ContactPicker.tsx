'use client';

/**
 * Выбор клиента для задачи на экране «Задачи» (CRM 1в, #2325). Ищет тем же
 * адресом, что экран «Клиенты» (`CRM_API.partner`), — своих клиентов
 * партнёра, по имени, почте или цифрам телефона. Задачу о клиенте можно
 * завести и из его карточки; здесь — для тех, кто начинает с «Задач», и для
 * агента, у которого «Клиенты» остаются на agent_clients (#2325, вопрос 5).
 */
import { useEffect, useState } from 'react';
import { Search, User, X } from 'lucide-react';
import type { ContactListItem } from '@/lib/crm/contact-queries';
import { CRM_API } from './api';

export interface PickedContact {
  id: string;
  display_name: string | null;
}

interface Props {
  value: PickedContact | null;
  onChange: (c: PickedContact | null) => void;
  disabled?: boolean;
}

type Found =
  | { kind: 'idle' }
  | { kind: 'ready'; items: ContactListItem[] }
  | { kind: 'error'; message: string };

const SHOWN = 5;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function readItems(json: unknown): ContactListItem[] | null {
  if (!isRecord(json) || json.success !== true || !isRecord(json.data) || !Array.isArray(json.data.items)) return null;
  return (json.data.items as unknown[]).filter((x): x is ContactListItem => isRecord(x) && typeof x.id === 'string');
}

export function ContactPicker({ value, onChange, disabled }: Props) {
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ q: string; state: Found } | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQuery(input.trim()), 300);
    return () => clearTimeout(t);
  }, [input]);

  useEffect(() => {
    if (!query || value) return;
    const ctrl = new AbortController();
    fetch(`${CRM_API.partner}?${new URLSearchParams({ q: query })}`, { signal: ctrl.signal })
      .then(async (res) => {
        const json: unknown = await res.json().catch(() => null);
        if (ctrl.signal.aborted) return;
        const items = res.ok ? readItems(json) : null;
        setFound({
          q: query,
          state: items
            ? { kind: 'ready', items: items.slice(0, SHOWN) }
            : { kind: 'error', message: isRecord(json) && typeof json.error === 'string' ? json.error : 'Не удалось найти клиентов' },
        });
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setFound({ q: query, state: { kind: 'error', message: 'Нет связи с сервером — поиск не выполнен' } });
      });
    return () => ctrl.abort();
  }, [query, value]);

  if (value) {
    return (
      <span className="ds-badge inline-flex items-center gap-1.5 bg-[var(--bg-hover)] text-[var(--text-secondary)]">
        <User className="w-3 h-3" /> {value.display_name ?? 'Клиент без имени'}
        <button
          type="button"
          disabled={disabled}
          onClick={() => { onChange(null); setInput(''); setQuery(''); }}
          aria-label="Задача без клиента"
          className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        >
          <X className="w-3 h-3" />
        </button>
      </span>
    );
  }

  const state: Found = query && found?.q === query ? found.state : { kind: 'idle' };

  return (
    <div className="space-y-1.5">
      <label className="relative block">
        <span className="sr-only">Клиент задачи (необязательно)</span>
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
        <input
          type="search"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={disabled}
          placeholder="Клиент, если задача о нём: имя, почта, цифры телефона"
          className="ds-input w-full pl-9"
        />
      </label>
      {state.kind === 'error' && <p className="text-xs text-[var(--text-muted)]">{state.message}</p>}
      {state.kind === 'ready' && state.items.length === 0 && (
        <p className="text-xs text-[var(--text-muted)]">Такого клиента нет — задача будет без клиента.</p>
      )}
      {state.kind === 'ready' && state.items.length > 0 && (
        <ul className="rounded-lg border border-[var(--border)] divide-y divide-[var(--border)]">
          {state.items.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onChange({ id: c.id, display_name: c.display_name })}
                className="w-full text-left px-3 py-2 text-sm hover:bg-[var(--bg-hover)] transition-colors duration-200"
              >
                <span className="text-[var(--text-primary)]">{c.display_name ?? 'Имя не указано'}</span>
                {(c.phone || c.email) && (
                  <span className="ml-2 text-xs text-[var(--text-muted)]">{c.phone ?? c.email}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
