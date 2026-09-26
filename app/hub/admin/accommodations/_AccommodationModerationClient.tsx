'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Home, Loader2, CheckCircle2, XCircle, Clock, Mail, ExternalLink } from 'lucide-react';
import { Protected } from '@/components/auth/Protected';
import { Sensitive } from '@/components/admin/shared/Sensitive';
import { ACCOMMODATION_TYPE_LABELS } from '@/lib/stay/accommodation-types';
import { ZONE_IDS, ZONE_NAMES, type ZoneId } from '@/lib/planner/constants';

/**
 * Проверка объектов жилья (решение владельца 26.09, миграция 1027):
 * объект выходит на витрину только после одобрения здесь, и только отсюда
 * ставится отметка «Проверено». Соседняя очередь — /hub/admin/operators
 * (там одобряется сам владелец как партнёр, здесь — его объекты).
 *
 * Зона планера (миграция 1031): по ней планер поездки предлагает объект на
 * ночи плана. NULL — «не размечена», такой объект планер не предлагает.
 * Администратор ставит зону при одобрении или отдельно («Сохранить зону»).
 */

type Tab = 'pending' | 'approved' | 'rejected' | 'all';

interface Row {
  id: string;
  name: string;
  type: string;
  shortDescription: string | null;
  description: string | null;
  address: string | null;
  totalRooms: number | null;
  pricePerNightFrom: number | null;
  isActive: boolean;
  isVerified: boolean;
  moderationStatus: string;
  moderationReason: string | null;
  plannerZone: string | null;
  moderatedAt: string | null;
  createdAt: string;
  partnerName: string | null;
  ownerEmail: string | null;
  roomsCount: number;
  photosCount: number;
}

const TAB_LABELS: Record<Tab, string> = {
  pending: 'На проверке',
  approved: 'Одобрены',
  rejected: 'Отклонены',
  all: 'Все',
};

const TYPE_LABELS: Record<string, string> = ACCOMMODATION_TYPE_LABELS;

function isRowList(v: unknown): v is { success: true; data: { accommodations: Row[]; counts: Record<string, number> } } {
  if (typeof v !== 'object' || v === null) return false;
  const d = (v as { data?: unknown }).data;
  return typeof d === 'object' && d !== null && Array.isArray((d as { accommodations?: unknown }).accommodations);
}

function isZoneId(v: string): v is ZoneId {
  return (ZONE_IDS as readonly string[]).includes(v);
}

function zoneLabel(z: string | null): string {
  if (z === null) return 'не размечена — планер объект не предлагает';
  return isZoneId(z) ? ZONE_NAMES[z] : `неизвестная зона «${z}»`;
}

function statusNote(r: Row): string {
  if (r.moderationStatus === 'approved') {
    if (!r.moderatedAt) return 'Одобрен до введения проверки (26.09) — решения администратора не было';
    return r.isActive ? 'Опубликован' : 'Одобрен, скрыт владельцем';
  }
  if (r.moderationStatus === 'rejected') return `Отклонён: ${r.moderationReason ?? 'причина не записана'}`;
  return 'Ждёт решения';
}

export default function AccommodationModerationClient() {
  const [tab, setTab] = useState<Tab>('pending');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [failed, setFailed] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<Row | null>(null);
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  // Черновик зоны по объекту: '' — «не размечена». Нет ключа — как в базе.
  const [zoneDraft, setZoneDraft] = useState<Record<string, string>>({});

  function draftZone(r: Row): string {
    return zoneDraft[r.id] ?? r.plannerZone ?? '';
  }

  const load = useCallback(async (t: Tab) => {
    setRows(null);
    setFailed(null);
    try {
      const res = await fetch(`/api/admin/accommodations?status=${t}`);
      const j: unknown = await res.json();
      if (!res.ok || !isRowList(j)) {
        const msg = typeof j === 'object' && j !== null && 'error' in j ? String((j as { error: unknown }).error) : null;
        setFailed(msg ?? 'Не удалось загрузить очередь');
        return;
      }
      setRows(j.data.accommodations);
      setCounts(j.data.counts);
    } catch {
      setFailed('Сетевая ошибка — очередь не загружена');
    }
  }, []);

  useEffect(() => { void load(tab); }, [load, tab]);

  async function decide(row: Row, action: 'approve' | 'reject', why?: string) {
    setActing(row.id);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/accommodations/${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action === 'approve'
          ? (isZoneId(draftZone(row)) ? { action, plannerZone: draftZone(row) } : { action })
          : { action, reason: why }),
      });
      const j = await res.json() as { success?: boolean; error?: string; message?: string };
      if (!res.ok || !j.success) {
        setNotice(j.error ?? 'Решение не сохранено');
        return;
      }
      setNotice(j.message ?? 'Решение сохранено');
      setRejecting(null);
      setReason('');
      void load(tab);
    } catch {
      setNotice('Сетевая ошибка — решение не сохранено');
    } finally {
      setActing(null);
    }
  }

  async function saveZone(row: Row) {
    const z = draftZone(row);
    setActing(row.id);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/accommodations/${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set_zone', plannerZone: isZoneId(z) ? z : null }),
      });
      const j = await res.json() as { success?: boolean; error?: string; message?: string };
      if (!res.ok || !j.success) {
        setNotice(j.error ?? 'Зона не сохранена');
        return;
      }
      setNotice(j.message ?? 'Зона сохранена');
      setZoneDraft(d => { const n = { ...d }; delete n[row.id]; return n; });
      void load(tab);
    } catch {
      setNotice('Сетевая ошибка — зона не сохранена');
    } finally {
      setActing(null);
    }
  }

  const reasonValid = reason.trim().length >= 5;

  return (
    <Protected roles={['admin']}>
      {rejecting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg w-full max-w-md p-6">
            <h3 className="font-semibold text-[var(--text-primary)] mb-1">Отклонить объект</h3>
            <p className="text-sm text-[var(--text-secondary)] mb-4">{rejecting.name}</p>
            <label className="ds-label" htmlFor="reject-reason">Причина — владелец увидит её в кабинете</label>
            <textarea
              id="reject-reason"
              className="ds-input resize-none"
              rows={3}
              maxLength={1000}
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder="Например: нет ни одного фото объекта; координата указывает в море"
            />
            <div className="flex gap-2 mt-4 justify-end">
              <button className="ds-btn ds-btn-secondary" onClick={() => { setRejecting(null); setReason(''); }}>
                Отмена
              </button>
              <button
                className="ds-btn ds-btn-danger"
                disabled={!reasonValid || acting === rejecting.id}
                onClick={() => decide(rejecting, 'reject', reason.trim())}
              >
                Отклонить
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="max-w-4xl mx-auto p-6">
        <div className="flex items-center gap-3 mb-2">
          <Home className="w-6 h-6 text-[var(--accent)]" />
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">Жильё: проверка объектов</h1>
          {(counts.pending ?? 0) > 0 && (
            <span className="ds-badge text-[var(--warning)] border border-[var(--border)]">
              {counts.pending} ждут
            </span>
          )}
        </div>
        <p className="text-sm text-[var(--text-secondary)] mb-6">
          На витрине — только одобренные здесь объекты. Одобрение ставит отметку «Проверено».
          Владельцы как партнёры проверяются в разделе{' '}
          <Link href="/hub/admin/operators" className="text-[var(--ocean)] hover:underline">Операторы</Link>.
        </p>

        <div className="flex gap-1 mb-4 bg-[var(--bg-primary)] rounded-lg p-1 w-fit flex-wrap">
          {(Object.keys(TAB_LABELS) as Tab[]).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                tab === t
                  ? 'bg-[var(--bg-card)] text-[var(--text-primary)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              }`}
            >
              {TAB_LABELS[t]}
              {t !== 'all' && (counts[t] ?? 0) > 0 && (
                <span className="ml-1.5 text-[10px] text-[var(--text-muted)]">({counts[t]})</span>
              )}
            </button>
          ))}
        </div>

        {notice && <p role="status" className="text-sm text-[var(--text-secondary)] mb-3">{notice}</p>}

        {failed && <p className="text-sm text-[var(--danger)]">{failed}</p>}

        {!failed && rows === null && (
          <div className="flex justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)]" />
          </div>
        )}

        {rows !== null && rows.length === 0 && (
          <div className="text-center py-16">
            <Clock className="w-10 h-10 text-[var(--text-muted)] mx-auto mb-3" />
            <p className="text-[var(--text-secondary)]">
              {tab === 'pending' ? 'Нет объектов на проверке' : 'Ничего нет'}
            </p>
          </div>
        )}

        {rows !== null && rows.length > 0 && (
          <div className="space-y-2">
            {rows.map(r => (
              <div key={r.id} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-semibold text-[var(--text-primary)]">{r.name}</p>
                      {r.isVerified && (
                        <span className="ds-badge text-[var(--success)] border border-[var(--border)]">Проверено</span>
                      )}
                    </div>
                    <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                      {[TYPE_LABELS[r.type] ?? r.type, r.address ?? 'адрес не указан'].join(' · ')}
                    </p>
                    <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                      {r.partnerName ?? 'партнёр не найден'}
                      {r.ownerEmail && (
                        <>
                          {' · '}
                          <a href={`mailto:${r.ownerEmail}`} className="inline-flex items-center gap-1 hover:text-[var(--accent)] transition-colors">
                            <Mail className="w-3 h-3" /><Sensitive>{r.ownerEmail}</Sensitive>
                          </a>
                        </>
                      )}
                    </p>
                    <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                      Номеров в продаже: {r.roomsCount} · фото: {r.photosCount}
                      {' · '}цена от: {r.pricePerNightFrom === null ? 'не указана' : `${new Intl.NumberFormat('ru-RU').format(r.pricePerNightFrom)} ₽`}
                    </p>
                    {(r.shortDescription || r.description) && (
                      <p className="text-xs text-[var(--text-muted)] mt-2 line-clamp-3">{r.shortDescription || r.description}</p>
                    )}
                    <p className="text-xs text-[var(--text-secondary)] mt-2">{statusNote(r)}</p>
                    <p className="text-xs text-[var(--text-secondary)] mt-1" data-testid="planner-zone">
                      Зона для планера: {zoneLabel(r.plannerZone)}
                    </p>
                    <div className="mt-2 flex items-center gap-2 flex-wrap">
                      <label className="sr-only" htmlFor={`zone-${r.id}`}>Зона для планера</label>
                      <select
                        id={`zone-${r.id}`}
                        className="ds-input w-auto min-h-[44px] text-sm"
                        value={draftZone(r)}
                        onChange={e => setZoneDraft(d => ({ ...d, [r.id]: e.target.value }))}
                      >
                        <option value="">Зона не размечена</option>
                        {ZONE_IDS.map(z => <option key={z} value={z}>{ZONE_NAMES[z]}</option>)}
                      </select>
                      {draftZone(r) !== (r.plannerZone ?? '') && (
                        <button
                          className="ds-btn ds-btn-secondary"
                          disabled={acting === r.id}
                          onClick={() => saveZone(r)}
                        >
                          Сохранить зону
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {r.moderationStatus === 'approved' && r.isActive && (
                      <Link
                        href={`/accommodations/${r.id}`}
                        className="p-2 text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                        aria-label={`Открыть на витрине ${r.name}`}
                      >
                        <ExternalLink className="w-4 h-4" />
                      </Link>
                    )}
                    {(r.moderationStatus !== 'approved' || !r.isVerified) && (
                      <button
                        className="ds-btn ds-btn-primary inline-flex items-center gap-1.5"
                        disabled={acting === r.id}
                        onClick={() => decide(r, 'approve')}
                      >
                        {acting === r.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                        Одобрить
                      </button>
                    )}
                    {r.moderationStatus !== 'rejected' && (
                      <button
                        className="ds-btn ds-btn-secondary inline-flex items-center gap-1.5"
                        disabled={acting === r.id}
                        onClick={() => setRejecting(r)}
                      >
                        <XCircle className="w-4 h-4" />
                        Отклонить
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Protected>
  );
}
