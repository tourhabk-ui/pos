'use client';

/**
 * «Клиенты» — экран CRM (CRM #2325).
 *
 * Два режима одного экрана. Партнёр видит своих клиентов и ведёт их: метки,
 * заметки, ручной клиент. Администратор видит клиентов всех партнёров — у
 * кого клиент, откуда и когда — и только смотрит (решение владельца 09.10):
 * записи о клиенте принадлежат его партнёру.
 *
 * Кто вошёл и чьи клиенты, решает сервер, экран лишь показывает ответ. Три
 * исхода загрузки не смешиваются (§4.0): «клиентов нет» — пустой список,
 * «не смогли загрузить» — ошибка с повтором, «раздел не для вас» — ответ
 * сервера словами.
 */
import { useEffect, useState } from 'react';
import { Users, Search, Plus, Phone, Mail, ChevronLeft, ChevronRight, X, Briefcase } from 'lucide-react';
import type { ContactListItem } from '@/lib/crm/contact-queries';
import type { AdminFacets, PartnerRef } from '@/lib/crm/admin-queries';
import { CRM_API, type CrmMode } from './api';
import { formatMoment, partnerCategoryLabel } from './labels';
import { ContactPanel } from './ContactPanel';
import { NewContactForm } from './NewContactForm';

type Item = ContactListItem & { partner?: PartnerRef };

interface ListData {
  items: Item[];
  total: number;
  page: number;
  pageSize: number;
  facets: AdminFacets | null;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; data: ListData }
  | { kind: 'error'; message: string; retry: boolean };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function readList(json: unknown): ListData | null {
  if (!isRecord(json) || json.success !== true || !isRecord(json.data)) return null;
  const d = json.data;
  if (!Array.isArray(d.items) || typeof d.total !== 'number' || typeof d.page !== 'number' || typeof d.pageSize !== 'number') {
    return null;
  }
  const facets = isRecord(d.facets) && Array.isArray(d.facets.categories) && Array.isArray(d.facets.partners)
    ? (d.facets as unknown as AdminFacets)
    : null;
  return { items: d.items as Item[], total: d.total, page: d.page, pageSize: d.pageSize, facets };
}

function errorText(json: unknown, fallback: string): string {
  return isRecord(json) && typeof json.error === 'string' ? json.error : fallback;
}

/** Склонение «клиент»: 1 клиент, 2 клиента, 5 клиентов. */
function clientsWord(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'клиент';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'клиента';
  return 'клиентов';
}

const SELECT = 'ds-input min-w-[160px]';

export function ContactsScreen({ mode = 'partner' }: { mode?: CrmMode }) {
  const isAdmin = mode === 'admin';
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [category, setCategory] = useState('');
  const [partner, setPartner] = useState('');
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  // Ответ помнит, на какой запрос он пришёл: сменился запрос — показывается
  // загрузка, а не прошлый список под новым поиском.
  const requestKey = `${page}|${tag ?? ''}|${category}|${partner}|${reload}|${query}`;
  const [result, setResult] = useState<{ key: string; state: LoadState } | null>(null);
  const state: LoadState = result?.key === requestKey ? result.state : { kind: 'loading' };
  // Фасеты держатся между запросами: фильтр не должен мигать на каждой букве.
  const [facets, setFacets] = useState<AdminFacets | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  // Поиск — после паузы в наборе, а не на каждую букву.
  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(input.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [input]);

  useEffect(() => {
    const ctrl = new AbortController();
    const params = new URLSearchParams({ page: String(page) });
    if (query) params.set('q', query);
    if (tag) params.set('tag', tag);
    if (isAdmin && category) params.set('category', category);
    if (isAdmin && partner) params.set('partner', partner);
    const done = (next: LoadState) => {
      if (ctrl.signal.aborted) return;
      setResult({ key: requestKey, state: next });
      if (next.kind === 'ready' && next.data.facets) setFacets(next.data.facets);
    };
    fetch(`${CRM_API[mode]}?${params}`, { signal: ctrl.signal })
      .then(async (res) => {
        const json: unknown = await res.json().catch(() => null);
        const data = res.ok ? readList(json) : null;
        if (data) done({ kind: 'ready', data });
        else if (res.status === 401 || res.status === 403) {
          done({
            kind: 'error',
            message: errorText(json, isAdmin ? 'Раздел доступен администратору' : 'Раздел доступен партнёрам платформы'),
            retry: false,
          });
        } else {
          done({ kind: 'error', message: errorText(json, 'Не удалось загрузить клиентов, попробуйте позже'), retry: true });
        }
      })
      .catch(() => done({ kind: 'error', message: 'Нет связи с сервером — клиенты не загружены', retry: true }));
    return () => ctrl.abort();
  }, [requestKey, query, tag, category, partner, page, mode, isAdmin]);

  const refresh = () => setReload((n) => n + 1);
  const pages = state.kind === 'ready' ? Math.max(1, Math.ceil(state.data.total / state.data.pageSize)) : 1;
  const filtered = Boolean(query || tag || category || partner);
  const partnersInCategory = (facets?.partners ?? []).filter((p) => !category || p.category === category);

  return (
    <div className="p-5 lg:p-6 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2.5">
          <Users className="w-4 h-4 text-[var(--text-muted)]" />
          <h1 className="text-sm font-semibold text-[var(--text-primary)] tracking-tight">
            {isAdmin ? 'Клиенты партнёров' : 'Клиенты'}
          </h1>
          {state.kind === 'ready' && (
            <span className="text-xs text-[var(--text-muted)]">
              {state.data.total} {clientsWord(state.data.total)}
            </span>
          )}
        </div>
        {!isAdmin && (
          <button type="button" onClick={() => setAdding(true)} className="ds-btn ds-btn-primary">
            <Plus className="w-4 h-4" /> Добавить клиента
          </button>
        )}
      </div>

      {isAdmin && (
        <p className="text-xs text-[var(--text-muted)]">
          Клиенты всех партнёров платформы — только для просмотра: метки и заметки ведёт сам партнёр.
        </p>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <label className="relative flex-1 min-w-[220px]">
          <span className="sr-only">Поиск клиента</span>
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
          <input
            type="search"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Имя, почта или последние цифры телефона"
            className="ds-input w-full pl-9"
          />
        </label>
        {isAdmin && (
          <>
            <select
              value={category}
              onChange={(e) => { setCategory(e.target.value); setPartner(''); setPage(1); }}
              aria-label="Роль партнёра"
              className={SELECT}
            >
              <option value="">Все роли</option>
              {(facets?.categories ?? []).map((c) => (
                <option key={c.category} value={c.category}>{partnerCategoryLabel(c.category)} · {c.n}</option>
              ))}
            </select>
            <select
              value={partner}
              onChange={(e) => { setPartner(e.target.value); setPage(1); }}
              aria-label="Партнёр"
              className={SELECT}
            >
              <option value="">Все партнёры</option>
              {partnersInCategory.map((p) => (
                <option key={p.id} value={p.id}>{p.name} · {p.n}</option>
              ))}
            </select>
          </>
        )}
        {tag && (
          <button
            type="button"
            onClick={() => { setTag(null); setPage(1); }}
            className="ds-badge inline-flex items-center gap-1 bg-[var(--accent-muted)] text-[var(--accent)]"
            aria-label={`Снять фильтр по метке ${tag}`}
          >
            {tag} <X className="w-3 h-3" />
          </button>
        )}
      </div>

      {state.kind === 'loading' && (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => <div key={i} className="ds-skeleton h-16 rounded-lg" />)}
        </div>
      )}

      {state.kind === 'error' && (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-6 text-center space-y-3">
          <p className="text-sm text-[var(--text-secondary)]">{state.message}</p>
          {state.retry && (
            <button type="button" onClick={refresh} className="ds-btn ds-btn-secondary">Повторить</button>
          )}
        </div>
      )}

      {state.kind === 'ready' && state.data.items.length === 0 && (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-8 text-center space-y-2">
          <p className="text-sm text-[var(--text-primary)]">
            {filtered ? 'По этому запросу клиентов нет' : 'Клиентов пока нет'}
          </p>
          {!filtered && (
            <p className="text-xs text-[var(--text-muted)]">
              {isAdmin
                ? 'Клиент появляется у партнёра сам после первой брони или заявки.'
                : 'Клиент появится здесь сам после первой брони или заявки. Знакомого клиента можно добавить вручную.'}
            </p>
          )}
        </div>
      )}

      {state.kind === 'ready' && state.data.items.length > 0 && (
        <ul className="space-y-2">
          {state.data.items.map((c) => (
            <li key={c.id} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg overflow-hidden">
              <button
                type="button"
                onClick={() => setOpenId(c.id)}
                className="w-full text-left p-4 hover:bg-[var(--bg-hover)] transition-colors duration-200"
              >
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0 space-y-1">
                    <p className="text-sm font-semibold text-[var(--text-primary)] truncate">
                      {c.display_name ?? <span className="text-[var(--text-muted)] font-normal">Имя не указано</span>}
                    </p>
                    <div className="flex items-center gap-3 flex-wrap text-xs text-[var(--text-secondary)]">
                      {c.phone && <span className="inline-flex items-center gap-1"><Phone className="w-3 h-3" />{c.phone}</span>}
                      {c.email && <span className="inline-flex items-center gap-1 min-w-0"><Mail className="w-3 h-3 shrink-0" /><span className="truncate">{c.email}</span></span>}
                      {!c.phone && !c.email && <span className="text-[var(--text-muted)]">Контактов нет</span>}
                    </div>
                    {c.partner && (
                      <p className="inline-flex items-center gap-1 text-xs text-[var(--ocean)]">
                        <Briefcase className="w-3 h-3" />
                        {c.partner.name} · {partnerCategoryLabel(c.partner.category)}
                      </p>
                    )}
                  </div>
                  <div className="text-xs text-[var(--text-muted)] shrink-0 space-y-0.5 sm:text-right">
                    <p>Последнее обращение: {formatMoment(c.last_activity_at) ?? '—'}</p>
                    <p>Обращений: {c.sources_count}</p>
                  </div>
                </div>
              </button>
              {c.tags.length > 0 && (
                <div className="flex gap-1 flex-wrap px-4 pb-3">
                  {c.tags.map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => { setTag(t); setPage(1); }}
                      className="ds-badge bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors duration-200"
                      aria-label={`Показать клиентов с меткой ${t}`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {state.kind === 'ready' && pages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-[var(--text-muted)]">Страница {page} из {pages}</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="ds-btn ds-btn-secondary disabled:opacity-40"
              aria-label="Предыдущая страница"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(pages, p + 1))}
              disabled={page >= pages}
              className="ds-btn ds-btn-secondary disabled:opacity-40"
              aria-label="Следующая страница"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {openId && (
        <ContactPanel
          contactId={openId}
          mode={mode}
          onClose={() => setOpenId(null)}
          onChanged={refresh}
        />
      )}

      {adding && !isAdmin && (
        <NewContactForm
          onClose={() => setAdding(false)}
          onCreated={(id) => { setAdding(false); refresh(); setOpenId(id); }}
          onExisting={(id) => { setAdding(false); setOpenId(id); }}
        />
      )}
    </div>
  );
}
