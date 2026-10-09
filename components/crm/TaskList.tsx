'use client';

/**
 * Задачи партнёра (CRM 1в, #2325): «перезвонить завтра», «уточнить состав
 * группы». Один компонент на два места: экран «Задачи» кабинета (все задачи,
 * у задачи с клиентом — его имя) и карточка клиента (задачи о нём).
 *
 * Срок вводится и показывается по Камчатке, как вся лента. Три исхода
 * загрузки не смешиваются (§4.0): «задач нет» — пустой список, «не смогли
 * загрузить» — ошибка с повтором.
 */
import { useEffect, useState } from 'react';
import { Check, Trash2, CalendarClock, User, Plus } from 'lucide-react';
import type { TaskItem, TaskStatus } from '@/lib/crm/tasks';
import { DETAILS_MAX, TITLE_MAX } from '@/lib/crm/event-kinds';
import {
  DUE_BUCKET_LABELS, defaultDueLocal, dueBucket, isoToKamchatkaLocal, kamchatkaLocalToIso, type DueBucket,
} from '@/lib/crm/task-time';
import { CRM_TASKS_API } from './api';
import { formatMomentTime } from './labels';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; items: TaskItem[]; now: Date }
  | { kind: 'error'; message: string; retry: boolean };

interface Props {
  /** Задачи об одном клиенте (карточка). Без него — все задачи партнёра. */
  contactId?: string;
  /** Экран «Задачи»: открыть карточку клиента задачи. */
  onOpenContact?: (contactId: string) => void;
  /** Задача выполнена — карточка добавит событие в ленту. */
  onCompleted?: (task: TaskItem) => void;
  /** Внешний сигнал перечитать (карточка клиента на экране что-то сохранила). */
  reloadKey?: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isTask(v: unknown): v is TaskItem {
  return isRecord(v) && typeof v.id === 'string' && typeof v.title === 'string' && typeof v.due_at === 'string';
}

function readItems(json: unknown): TaskItem[] | null {
  if (!isRecord(json) || json.success !== true || !isRecord(json.data) || !Array.isArray(json.data.items)) return null;
  return json.data.items.every(isTask) ? (json.data.items as TaskItem[]) : null;
}

function readTask(json: unknown): TaskItem | null {
  return isRecord(json) && json.success === true && isTask(json.data) ? json.data : null;
}

function errorText(json: unknown, fallback: string): string {
  return isRecord(json) && typeof json.error === 'string' ? json.error : fallback;
}

const BUCKET_ORDER: readonly DueBucket[] = ['overdue', 'today', 'tomorrow', 'later'];

const BUCKET_TONE: Readonly<Record<DueBucket, string>> = {
  overdue: 'text-[var(--danger)]',
  today: 'text-[var(--accent)]',
  tomorrow: 'text-[var(--text-secondary)]',
  later: 'text-[var(--text-muted)]',
};

export function TaskList({ contactId, onOpenContact, onCompleted, reloadKey = 0 }: Props) {
  const inCard = Boolean(contactId);
  const [status, setStatus] = useState<TaskStatus>('open');
  const [reload, setReload] = useState(0);
  const requestKey = `${status}|${contactId ?? ''}|${reload}|${reloadKey}`;
  const [result, setResult] = useState<{ key: string; state: LoadState } | null>(null);
  const state: LoadState = result?.key === requestKey ? result.state : { kind: 'loading' };

  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [moving, setMoving] = useState<{ id: string; value: string } | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    const params = new URLSearchParams({ status });
    if (contactId) params.set('contact_id', contactId);
    const done = (next: LoadState) => {
      if (!ctrl.signal.aborted) setResult({ key: requestKey, state: next });
    };
    fetch(`${CRM_TASKS_API}?${params}`, { signal: ctrl.signal })
      .then(async (res) => {
        const json: unknown = await res.json().catch(() => null);
        const items = res.ok ? readItems(json) : null;
        if (items) done({ kind: 'ready', items, now: new Date() });
        else if (res.status === 401 || res.status === 403) {
          done({ kind: 'error', message: errorText(json, 'Раздел доступен партнёрам платформы'), retry: false });
        } else {
          done({ kind: 'error', message: errorText(json, 'Не удалось загрузить задачи, попробуйте позже'), retry: true });
        }
      })
      .catch(() => done({ kind: 'error', message: 'Нет связи с сервером — задачи не загружены', retry: true }));
    return () => ctrl.abort();
  }, [requestKey, status, contactId]);

  const refresh = () => setReload((n) => n + 1);

  /** Все записи — по адресу задач: `path` — '' (новая) или '/<id>'. */
  async function send(path: string, init: RequestInit, fallback: string): Promise<unknown | null> {
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch(`${CRM_TASKS_API}${path}`, { ...init, headers: { 'Content-Type': 'application/json' } });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok || !isRecord(json) || json.success !== true) {
        setActionError(errorText(json, fallback));
        if (res.status === 404) refresh();
        return null;
      }
      return json;
    } catch {
      setActionError('Нет связи с сервером — не сохранено');
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    const t = title.trim();
    const dueIso = kamchatkaLocalToIso(due || defaultDueLocal(new Date()));
    if (!t) return;
    if (!dueIso) { setActionError('Срок не похож на дату'); return; }
    const json = await send('', {
      method: 'POST',
      body: JSON.stringify({ title: t, details: details.trim() || null, due_at: dueIso, contact_id: contactId ?? null }),
    }, 'Не удалось сохранить задачу, попробуйте позже');
    if (!json) return;
    setTitle('');
    setDetails('');
    setDue('');
    if (status === 'open') refresh(); else setStatus('open');
  }

  async function complete(task: TaskItem) {
    const json = await send(`/${encodeURIComponent(task.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ action: 'done' }),
    }, 'Не удалось отметить, попробуйте позже');
    const doneTask = readTask(json);
    if (!doneTask) return;
    setResult((r) => (r && r.state.kind === 'ready'
      ? { key: r.key, state: { ...r.state, items: r.state.items.filter((x) => x.id !== task.id) } }
      : r));
    onCompleted?.(doneTask);
  }

  async function move(task: TaskItem, value: string) {
    const dueIso = kamchatkaLocalToIso(value);
    if (!dueIso) { setActionError('Срок не похож на дату'); return; }
    const json = await send(`/${encodeURIComponent(task.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ due_at: dueIso }),
    }, 'Не удалось перенести, попробуйте позже');
    if (!readTask(json)) return;
    setMoving(null);
    refresh();
  }

  async function remove(task: TaskItem) {
    const json = await send(`/${encodeURIComponent(task.id)}`, { method: 'DELETE' }, 'Не удалось удалить, попробуйте позже');
    setConfirmDelete(null);
    if (!json) return;
    setResult((r) => (r && r.state.kind === 'ready'
      ? { key: r.key, state: { ...r.state, items: r.state.items.filter((x) => x.id !== task.id) } }
      : r));
  }

  const groups = state.kind === 'ready' && status === 'open'
    ? BUCKET_ORDER.map((b) => ({ bucket: b, items: state.items.filter((t) => dueBucket(t.due_at, state.now) === b) }))
      .filter((g) => g.items.length > 0)
    : [];

  function renderTask(task: TaskItem) {
    const open = task.done_at === null;
    return (
      <li key={task.id} className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-3 text-sm space-y-1.5">
        <div className="flex items-start gap-3">
          {open ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void complete(task)}
              aria-label={`Отметить выполненной: ${task.title}`}
              className="mt-0.5 w-5 h-5 shrink-0 rounded border border-[var(--border)] hover:border-[var(--success)] hover:text-[var(--success)] text-transparent inline-flex items-center justify-center transition-colors duration-200 disabled:opacity-40"
            >
              <Check className="w-3.5 h-3.5" />
            </button>
          ) : (
            <span className="mt-0.5 w-5 h-5 shrink-0 rounded bg-[var(--success)] text-[var(--bg-card)] inline-flex items-center justify-center" aria-hidden="true">
              <Check className="w-3.5 h-3.5" />
            </span>
          )}
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className={open ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)] line-through'}>{task.title}</p>
            {task.details && <p className="text-xs text-[var(--text-muted)] whitespace-pre-line">{task.details}</p>}
            <p className="text-xs text-[var(--text-muted)] flex items-center gap-3 flex-wrap">
              <span className="inline-flex items-center gap-1">
                <CalendarClock className="w-3 h-3" />
                {open ? `срок ${formatMomentTime(task.due_at) ?? '—'}` : `выполнено ${formatMomentTime(task.done_at) ?? '—'}`}
              </span>
              {!inCard && task.contact && (
                onOpenContact ? (
                  <button
                    type="button"
                    onClick={() => onOpenContact(task.contact!.id)}
                    className="inline-flex items-center gap-1 text-[var(--ocean)] hover:underline"
                  >
                    <User className="w-3 h-3" /> {task.contact.display_name ?? 'Клиент без имени'}
                  </button>
                ) : (
                  <span className="inline-flex items-center gap-1"><User className="w-3 h-3" /> {task.contact.display_name ?? 'Клиент без имени'}</span>
                )
              )}
            </p>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {open && (
              <button
                type="button"
                disabled={busy}
                onClick={() => setMoving(moving?.id === task.id ? null : { id: task.id, value: isoToKamchatkaLocal(task.due_at) })}
                aria-label={`Перенести срок: ${task.title}`}
                className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors duration-200 disabled:opacity-40"
              >
                <CalendarClock className="w-4 h-4" />
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirmDelete(confirmDelete === task.id ? null : task.id)}
              aria-label={`Удалить задачу: ${task.title}`}
              className="p-1 text-[var(--text-muted)] hover:text-[var(--danger)] transition-colors duration-200 disabled:opacity-40"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>
        {moving?.id === task.id && (
          <div className="flex gap-2 flex-wrap pl-8">
            <input
              type="datetime-local"
              value={moving.value}
              onChange={(e) => setMoving({ id: task.id, value: e.target.value })}
              aria-label="Новый срок, время камчатское"
              className="ds-input"
            />
            <button type="button" disabled={busy || !moving.value} onClick={() => void move(task, moving.value)} className="ds-btn ds-btn-secondary">
              Перенести
            </button>
          </div>
        )}
        {confirmDelete === task.id && (
          <div className="flex items-center gap-2 flex-wrap pl-8 text-xs">
            <span className="text-[var(--text-secondary)]">Удалить задачу? Отметка в ленте клиента, если была, останется.</span>
            <button type="button" disabled={busy} onClick={() => void remove(task)} className="ds-btn ds-btn-danger">Удалить</button>
            <button type="button" disabled={busy} onClick={() => setConfirmDelete(null)} className="ds-btn ds-btn-secondary">Отмена</button>
          </div>
        )}
      </li>
    );
  }

  return (
    <div className="space-y-3">
      <form
        onSubmit={(e) => { e.preventDefault(); void create(); }}
        className="space-y-2 rounded-lg border border-[var(--border)] p-3"
        aria-label="Новая задача"
      >
        <div className="flex gap-2 flex-wrap">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={TITLE_MAX}
            placeholder={inCard ? 'Что сделать: перезвонить, уточнить состав группы…' : 'Что сделать'}
            aria-label="Что сделать"
            className="ds-input flex-1 min-w-[180px]"
          />
          <input
            type="datetime-local"
            value={due}
            onChange={(e) => setDue(e.target.value)}
            aria-label="Срок, время камчатское (по умолчанию — завтра в 10:00)"
            className="ds-input"
          />
        </div>
        {title.trim() && (
          <textarea
            value={details}
            onChange={(e) => setDetails(e.target.value)}
            maxLength={DETAILS_MAX}
            rows={2}
            placeholder="Подробности, если нужны"
            aria-label="Подробности задачи"
            className="ds-input w-full"
          />
        )}
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <p className="text-xs text-[var(--text-muted)]">Срок — по камчатскому времени; не указан — завтра в 10:00.</p>
          <button type="submit" disabled={busy || !title.trim()} className="ds-btn ds-btn-secondary">
            <Plus className="w-4 h-4" /> Добавить задачу
          </button>
        </div>
      </form>

      {!inCard && (
        <div className="flex gap-2" role="tablist" aria-label="Какие задачи показать">
          {(['open', 'done'] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={status === s}
              onClick={() => setStatus(s)}
              className={`ds-btn ${status === s ? 'ds-btn-primary' : 'ds-btn-secondary'}`}
            >
              {s === 'open' ? 'Открытые' : 'Выполненные'}
            </button>
          ))}
        </div>
      )}

      {actionError && <p className="text-sm text-[var(--danger)]" role="alert">{actionError}</p>}

      {state.kind === 'loading' && (
        <div className="space-y-2">
          {Array.from({ length: inCard ? 1 : 4 }).map((_, i) => <div key={i} className="ds-skeleton h-14 rounded-lg" />)}
        </div>
      )}

      {state.kind === 'error' && (
        <div className="rounded-lg border border-[var(--border)] p-4 text-center space-y-2">
          <p className="text-sm text-[var(--text-secondary)]">{state.message}</p>
          {state.retry && <button type="button" onClick={refresh} className="ds-btn ds-btn-secondary">Повторить</button>}
        </div>
      )}

      {state.kind === 'ready' && state.items.length === 0 && (
        <p className="text-xs text-[var(--text-muted)]">
          {status === 'done'
            ? 'Выполненных задач пока нет.'
            : inCard ? 'Открытых задач по клиенту нет.' : 'Открытых задач нет.'}
        </p>
      )}

      {state.kind === 'ready' && status === 'open' && groups.map((g) => (
        <section key={g.bucket} className="space-y-2" aria-label={DUE_BUCKET_LABELS[g.bucket]}>
          <p className={`text-xs font-semibold ${BUCKET_TONE[g.bucket]}`}>{DUE_BUCKET_LABELS[g.bucket]} · {g.items.length}</p>
          <ul className="space-y-2">{g.items.map(renderTask)}</ul>
        </section>
      ))}

      {state.kind === 'ready' && status === 'done' && state.items.length > 0 && (
        <ul className="space-y-2">{state.items.map(renderTask)}</ul>
      )}
    </div>
  );
}
