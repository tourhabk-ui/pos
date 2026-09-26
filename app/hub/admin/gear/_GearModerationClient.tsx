'use client';

import { useCallback, useEffect, useState } from 'react';
import { Package, Loader2, CheckCircle2, XCircle, Clock } from 'lucide-react';
import { Protected } from '@/components/auth/Protected';

/**
 * Проверка позиций проката (решение владельца 26.09, миграция 1030):
 * позиция выходит в каталог только после одобрения здесь.
 *
 * Соседняя очередь — /hub/admin/accommodations (то же для жилья). Очереди
 * раздельные: у позиции проката своя причина отказа и свой партнёр, и
 * смешивать их в одном списке значило бы решать про разные вещи одной кнопкой.
 */

type Tab = 'pending' | 'approved' | 'rejected' | 'all';

interface Row {
  id: string;
  name: string;
  category: string;
  price_per_day: string | number | null;
  is_active: boolean;
  moderation_status: string;
  moderation_reason: string | null;
  moderated_at: string | null;
  created_at: string;
  partner_name: string | null;
  partner_verified: boolean | null;
}

const TAB_LABELS: Record<Tab, string> = {
  pending: 'На проверке',
  approved: 'Одобрены',
  rejected: 'Отклонены',
  all: 'Все',
};

function isRowList(v: unknown): v is { success: true; data: Row[] } {
  if (typeof v !== 'object' || v === null) return false;
  return Array.isArray((v as { data?: unknown }).data);
}

/** Что именно случилось с позицией — словами, без догадок. */
function statusNote(r: Row): string {
  if (r.moderation_status === 'approved') {
    // NULL в moderated_at — «одобрена до введения проверки» (1030), а не
    // решение неизвестно когда: до 26.09 заведение и было публикацией.
    if (!r.moderated_at) return 'Одобрена до введения проверки (26.09) — решения администратора не было';
    return r.is_active ? 'В каталоге' : 'Одобрена, снята партнёром';
  }
  if (r.moderation_status === 'rejected') {
    return `Отклонена: ${r.moderation_reason ?? 'причина не записана'}`;
  }
  if (r.moderation_status === 'pending') return 'Ждёт решения';
  return `Статус «${r.moderation_status}» не распознан`;
}

export default function GearModerationClient() {
  const [tab, setTab] = useState<Tab>('pending');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<Row | null>(null);
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (t: Tab) => {
    setRows(null);
    setFailed(null);
    try {
      const res = await fetch(`/api/admin/gear${t === 'all' ? '' : `?status=${t}`}`);
      const j: unknown = await res.json();
      if (!res.ok || !isRowList(j)) {
        const msg = typeof j === 'object' && j !== null && 'error' in j
          ? String((j as { error: unknown }).error) : null;
        setFailed(msg ?? 'Не удалось загрузить очередь');
        return;
      }
      setRows(j.data);
    } catch {
      setFailed('Сетевая ошибка — очередь не загружена');
    }
  }, []);

  useEffect(() => { void load(tab); }, [tab, load]);

  const decide = useCallback(async (row: Row, action: 'approve' | 'reject', why?: string) => {
    setActing(row.id);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/gear/${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action === 'approve' ? { action } : { action, reason: why }),
      });
      const j: unknown = await res.json();
      const msg = typeof j === 'object' && j !== null && 'message' in j
        ? String((j as { message: unknown }).message) : null;
      const err = typeof j === 'object' && j !== null && 'error' in j
        ? String((j as { error: unknown }).error) : null;
      if (!res.ok) {
        setNotice(err ?? 'Решение не сохранено');
        return;
      }
      setNotice(msg ?? 'Решение сохранено');
      setRejecting(null);
      setReason('');
      await load(tab);
    } catch {
      setNotice('Сетевая ошибка — решение не сохранено');
    } finally {
      setActing(null);
    }
  }, [load, tab]);

  return (
    <Protected roles={['admin']}>
      <div className="ds-page">
        <h1 className="ds-h1 flex items-center gap-2">
          <Package className="w-6 h-6" style={{ color: 'var(--accent)' }} />
          Прокат: проверка
        </h1>
        <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>
          Позиция появляется в каталоге только после одобрения. Отказ требует причины — партнёр увидит её в кабинете.
        </p>

        <div className="flex flex-wrap gap-2 mb-4">
          {(Object.keys(TAB_LABELS) as Tab[]).map(t => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className="px-3 py-1.5 rounded-lg text-sm"
              style={{
                background: t === tab ? 'var(--accent)' : 'var(--bg-card)',
                color: t === tab ? '#FFFFFF' : 'var(--text-secondary)',
                border: '1px solid var(--border)',
              }}
            >
              {TAB_LABELS[t]}
            </button>
          ))}
        </div>

        {notice && (
          <div className="ds-card mb-4 text-sm" style={{ color: 'var(--text-primary)' }}>{notice}</div>
        )}

        {failed && (
          <div className="ds-card mb-4 text-sm" style={{ color: 'var(--danger)' }}>
            {failed}
            <button type="button" onClick={() => void load(tab)}
              className="ml-2 underline underline-offset-2" style={{ color: 'var(--ocean)' }}>
              Повторить
            </button>
          </div>
        )}

        {rows === null && !failed && (
          <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
            <Loader2 className="w-4 h-4 animate-spin" />
            Загружаю очередь
          </div>
        )}

        {rows !== null && rows.length === 0 && (
          <div className="ds-card text-sm" style={{ color: 'var(--text-secondary)' }}>
            {tab === 'pending' ? 'Позиций на проверке нет' : 'В этой группе позиций нет'}
          </div>
        )}

        <div className="flex flex-col gap-3">
          {(rows ?? []).map(r => (
            <div key={r.id} className="ds-card">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-semibold" style={{ color: 'var(--text-primary)' }}>{r.name}</p>
                  <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
                    {r.category}
                    {r.price_per_day != null && ` · ${Number(r.price_per_day)} руб/сутки`}
                    {r.partner_name && ` · ${r.partner_name}`}
                    {r.partner_verified === false && ' · партнёр не проверен'}
                  </p>
                  <p className="text-xs mt-1 flex items-center gap-1.5" style={{
                    color: r.moderation_status === 'pending' ? 'var(--warning)'
                      : r.moderation_status === 'rejected' ? 'var(--danger)'
                        : 'var(--text-muted)',
                  }}>
                    {r.moderation_status === 'pending' && <Clock className="w-3.5 h-3.5" />}
                    {statusNote(r)}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={acting === r.id || r.moderation_status === 'approved'}
                    onClick={() => void decide(r, 'approve')}
                    className="ds-btn ds-btn-primary text-xs disabled:opacity-60 inline-flex items-center gap-1.5"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Одобрить
                  </button>
                  <button
                    type="button"
                    disabled={acting === r.id}
                    onClick={() => { setRejecting(r); setReason(''); }}
                    className="ds-btn ds-btn-secondary text-xs disabled:opacity-60 inline-flex items-center gap-1.5"
                  >
                    <XCircle className="w-3.5 h-3.5" />
                    Отклонить
                  </button>
                </div>
              </div>

              {rejecting?.id === r.id && (
                <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--border)' }}>
                  <label className="ds-label" htmlFor={`reason-${r.id}`}>
                    Причина отказа — партнёр увидит её в кабинете
                  </label>
                  <textarea
                    id={`reason-${r.id}`}
                    value={reason}
                    onChange={e => setReason(e.target.value)}
                    rows={2}
                    className="ds-input w-full"
                    placeholder="Что исправить, чтобы позиция прошла проверку"
                  />
                  <div className="flex gap-2 mt-2">
                    <button
                      type="button"
                      disabled={reason.trim().length < 5 || acting === r.id}
                      onClick={() => void decide(r, 'reject', reason.trim())}
                      className="ds-btn ds-btn-danger text-xs disabled:opacity-60"
                    >
                      Отклонить с причиной
                    </button>
                    <button type="button" onClick={() => { setRejecting(null); setReason(''); }}
                      className="ds-btn ds-btn-secondary text-xs">
                      Отмена
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </Protected>
  );
}
