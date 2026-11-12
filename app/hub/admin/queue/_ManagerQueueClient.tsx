'use client';

/**
 * Очередь менеджера (план «после отказа», этап 3б): клиенты, которым после
 * отказа нужен звонок или замена, одним списком, и отметка «Взял».
 *
 * Три части читаются независимо: не прочитавшаяся названа «сбой», а не «никого
 * нет». «Взял» — не «сделано»: отметка говорит, что случаем занимается
 * человек, и второй менеджер видит кто. Случай уходит из очереди сам, когда
 * сообщение до клиента дошло или заявка изменилась (бронь, новая дата,
 * возврат в работу).
 */
import { useCallback, useState } from 'react';
import useSWR from 'swr';
import { AlertTriangle, Loader2, Phone } from 'lucide-react';
import { QUEUE_KINDS, type ManagerQueue, type QueueItem, type QueueKind, type QueueSource } from '@/lib/manager-queue/types';
import { QUEUE_SECTION, kamchatkaStamp, queueRequestId, queueStateLines, queueSubjectLine, ruDate, takeLine } from '@/lib/manager-queue/words';

const QUEUE_URL = '/api/admin/manager-queue';

/** Не 200, не тот ответ или сеть — отказ: экран назовёт его сбоем, а не пустой очередью. */
async function fetchQueue(url: string): Promise<ManagerQueue> {
  const res = await fetch(url);
  const json = await res.json().catch(() => null) as { success?: boolean; data?: ManagerQueue } | null;
  if (!res.ok || !json?.success || !json.data) throw new Error('очередь не загрузилась');
  return json.data;
}

function happened(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${kamchatkaStamp(d)} по Камчатке`;
}

function ItemCard({ item, busy, onAct }: { item: QueueItem; busy: boolean; onAct: (item: QueueItem, action: 'take' | 'release') => void }) {
  return (
    <li className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4 space-y-2" data-testid={`queue-${item.kind}-${item.id}`}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <p className="text-sm font-medium text-[var(--text-primary)]">{queueSubjectLine(item)}</p>
        <span className="text-sm text-[var(--text-muted)]">{happened(item.happened_at)}</span>
      </div>
      {queueStateLines(item).map((line) => (
        <p key={line} className="text-sm text-[var(--text-secondary)]">{line}</p>
      ))}
      <p className="text-sm text-[var(--text-primary)] flex flex-wrap items-center gap-x-4 gap-y-1">
        <span>{item.contact_name ?? 'Имя не записано'}</span>
        {item.contact_phone ? (
          <a href={`tel:${item.contact_phone}`} className="inline-flex items-center gap-1 text-[var(--ocean)]">
            <Phone size={14} aria-hidden /> {item.contact_phone}
          </a>
        ) : <span className="text-[var(--text-muted)]">Телефон не записан</span>}
      </p>
      <p className="text-sm text-[var(--text-muted)] break-all">Заявка {queueRequestId(item)}</p>
      <div className="flex flex-wrap items-center gap-3">
        {item.take ? (
          <>
            <span className="text-sm text-[var(--text-secondary)]">{takeLine(item.take)}</span>
            <button type="button" className="ds-btn ds-btn-secondary" disabled={busy} onClick={() => onAct(item, 'release')}>
              Вернуть в очередь
            </button>
          </>
        ) : (
          <button type="button" className="ds-btn ds-btn-primary" disabled={busy} onClick={() => onAct(item, 'take')}>
            {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null} Взял
          </button>
        )}
      </div>
    </li>
  );
}

function Section({ kind, source, busyKey, onAct }: {
  kind: QueueKind; source: QueueSource<QueueItem>; busyKey: string | null;
  onAct: (item: QueueItem, action: 'take' | 'release') => void;
}) {
  const words = QUEUE_SECTION[kind];
  const waiting = source.state === 'ok' ? source.items.filter((i) => !i.take) : [];
  const taken = source.state === 'ok' ? source.items.filter((i) => i.take) : [];
  return (
    <section aria-labelledby={`queue-${kind}`} className="space-y-3">
      <div>
        <h2 id={`queue-${kind}`} className="text-base font-semibold text-[var(--text-primary)]">
          {words.title}{source.state === 'ok' ? ` — ждут: ${waiting.length}` : ''}
        </h2>
        <p className="text-sm text-[var(--text-secondary)] mt-1">{words.lead}</p>
      </div>
      {source.state === 'failed' ? (
        <p className="text-sm text-[var(--text-secondary)] flex items-center gap-2" role="alert">
          <AlertTriangle className="w-4 h-4 text-[var(--warning)]" aria-hidden /> Не смогли прочитать эту часть очереди — это сбой, а не «никого нет».
        </p>
      ) : source.items.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">{words.empty}</p>
      ) : (
        <>
          {source.more && <p className="text-sm text-[var(--warning)]">Разобраны только последние случаи — более ранние в список не попали.</p>}
          {waiting.length > 0 && (
            <ul className="space-y-3" aria-label={`${words.title}: ждут`}>
              {waiting.map((i) => <ItemCard key={i.id} item={i} busy={busyKey === `${i.kind}:${i.id}`} onAct={onAct} />)}
            </ul>
          )}
          {taken.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm text-[var(--text-secondary)]">Взято за последние 7 дней: {taken.length}</p>
              <ul className="space-y-3" aria-label={`${words.title}: взято`}>
                {taken.map((i) => <ItemCard key={i.id} item={i} busy={busyKey === `${i.kind}:${i.id}`} onAct={onAct} />)}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}

export default function ManagerQueueClient() {
  // Очередь общая на всех менеджеров: при возврате во вкладку список перечитывается сам.
  const { data: queue, error: loadError, isLoading, mutate } = useSWR<ManagerQueue>(QUEUE_URL, fetchQueue);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const act = useCallback(async (item: QueueItem, action: 'take' | 'release') => {
    setBusyKey(`${item.kind}:${item.id}`);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(QUEUE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: item.kind, id: item.id, action }),
      });
      const json = await res.json().catch(() => null) as { success?: boolean; outcome?: string; error?: string } | null;
      if (res.ok && json?.success) {
        setNotice(
          json.outcome === 'already' ? 'Этот случай уже взят — список обновлён.'
            : json.outcome === 'not_taken' ? 'Отметки уже не было — список обновлён.'
              : action === 'take' ? 'Отмечено: взяли вы.' : 'Отметка снята: случай снова ждёт.',
        );
      } else {
        setError(json?.error ?? 'Не удалось записать — попробуйте ещё раз');
      }
    } catch {
      setError('Сеть недоступна — ничего не изменено');
    }
    setBusyKey(null);
    await mutate();
  }, [mutate]);

  return (
    <div className="p-5 lg:p-6 space-y-8">
      <div>
        <h1 className="text-lg font-semibold text-[var(--text-primary)]">Очередь менеджера</h1>
        <p className="text-sm text-[var(--text-secondary)] mt-1">
          Клиенты, которым после отказа нужен звонок или замена. «Взял» — отметка, что случаем занимаетесь вы: второй
          менеджер её увидит. Случай уходит из списка сам, когда сообщение до клиента дошло или заявка изменилась:
          появилась бронь, новая дата, заявку вернули в работу.
        </p>
        {queue && !loadError && (
          <p className="text-sm text-[var(--text-muted)] mt-1">
            Очередь ведётся с {ruDate(queue.since)}: более ранние отказы — в разделе «CRM — Лиды».
          </p>
        )}
      </div>

      {notice && <p className="text-sm text-[var(--success)]" role="status">{notice}</p>}
      {error && <p className="text-sm text-[var(--danger)]" role="alert">{error}</p>}

      {/* Сбой перечитывания прячет и прежний список: «Взял» на устаревшем списке хуже, чем просьба обновить. */}
      {loadError ? (
        <p className="text-sm text-[var(--text-secondary)] flex items-center gap-2" role="alert">
          <AlertTriangle className="w-4 h-4 text-[var(--warning)]" aria-hidden /> Очередь не загрузилась — это сбой, а не «никого нет». Обновите страницу.
        </p>
      ) : isLoading || !queue ? (
        <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-[var(--accent)]" aria-hidden /></div>
      ) : (
        QUEUE_KINDS.map((kind) => (
          <Section key={kind} kind={kind} source={queue[kind] as QueueSource<QueueItem>} busyKey={busyKey} onAct={act} />
        ))
      )}
    </div>
  );
}
