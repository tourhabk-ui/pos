'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  DndContext, PointerSensor, TouchSensor, useSensor, useSensors,
  useDraggable, useDroppable, DragOverlay,
  type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core';
import { Phone, AlertTriangle } from 'lucide-react';
import { MANUAL_LEAD_STATUSES, type LeadStatus } from '@/lib/types/statuses';
import { STATUS_META, ScoreBadge, formatDate, type Lead } from './_LeadsClient';

/**
 * Канбан — только для 5 ручных статусов (те же, что на кнопках карточки и
 * во вкладках списка). AI-статусы (ai_processing/ai_qualified/proposal_sent/
 * awaiting_confirm) сюда намеренно не выведены отдельными колонками: их
 * ставит конвейер (lib/services/operators/lead-processor.service.ts), а не
 * рука администратора, и класть их рядом с перетаскиваемыми колонками
 * подразумевало бы, что их тоже можно перетащить — это не так. Полная
 * картина по всем девяти статусам остаётся в «Списке» (вкладка «Все»).
 */
export const COLUMNS = MANUAL_LEAD_STATUSES;

export async function fetchColumn(status: LeadStatus): Promise<Lead[]> {
  const res = await fetch(`/api/leads?status=${status}&limit=200`);
  if (!res.ok) throw new Error(`status ${status}: HTTP ${res.status}`);
  const data = await res.json() as { leads: Lead[] };
  return data.leads;
}

/**
 * Чистая функция: переносит лида между колонками. Используется и для
 * оптимистичного переноса при drop, и для отката при неудачном PATCH
 * (тот же перенос в обратную сторону) — так они гарантированно симметричны
 * и не расходятся в мелочах, если один из путей поправят, а другой забудут.
 */
export function moveBetweenColumns(
  columns: Record<LeadStatus, Lead[]>,
  leadId: string,
  from: LeadStatus,
  to: LeadStatus,
): Record<LeadStatus, Lead[]> {
  const lead = columns[from].find(l => l.id === leadId);
  if (!lead || from === to) return columns;
  return {
    ...columns,
    [from]: columns[from].filter(l => l.id !== leadId),
    [to]: [{ ...lead, status: to }, ...columns[to]],
  };
}

function KanbanCard({ lead }: { lead: Lead }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: lead.id,
    data: { lead },
  });
  const interests = lead.source_data?.interests ?? [];

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className="ds-card rounded-lg p-3 cursor-grab active:cursor-grabbing touch-none select-none"
      style={{
        opacity: isDragging ? 0.4 : 1,
        transform: transform ? `translate(${transform.x}px, ${transform.y}px)` : undefined,
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium text-sm text-[var(--text-primary)] truncate">{lead.name}</span>
        <ScoreBadge score={lead.ai_score} />
      </div>
      <div className="flex items-center gap-1 mt-1 text-xs text-[var(--text-secondary)]">
        <Phone size={11} />
        {lead.phone}
      </div>
      {interests.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {interests.slice(0, 3).map(i => (
            <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent)]/10 text-[var(--accent)]">
              {i}
            </span>
          ))}
        </div>
      )}
      <div className="text-[11px] text-[var(--text-muted)] mt-2">{formatDate(lead.created_at)}</div>
    </div>
  );
}

function KanbanColumn({ status, leads }: { status: LeadStatus; leads: Lead[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const meta = STATUS_META[status];

  return (
    <div className="flex flex-col w-72 shrink-0">
      <div className="flex items-center gap-2 mb-2 px-1">
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${meta.color}`}>{meta.label}</span>
        <span className="text-xs text-[var(--text-muted)]">{leads.length}</span>
      </div>
      <div
        ref={setNodeRef}
        className="flex-1 rounded-lg p-2 space-y-2 min-h-[200px] transition-colors"
        style={{
          background: isOver ? 'color-mix(in srgb, var(--accent) 8%, transparent)' : 'var(--bg-hover)',
          border: isOver ? '1px dashed var(--accent)' : '1px dashed transparent',
        }}
      >
        {leads.length === 0 ? (
          <p className="text-xs text-[var(--text-muted)] text-center py-6">Пусто</p>
        ) : (
          leads.map(lead => <KanbanCard key={lead.id} lead={lead} />)
        )}
      </div>
    </div>
  );
}

export function LeadsKanban() {
  const [columns, setColumns]   = useState<Record<LeadStatus, Lead[]> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeLead, setActiveLead] = useState<Lead | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);

  const sensors = useSensors(
    // distance-порог отличает клик/тап от перетаскивания
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    // на тач-экране короткое удержание — иначе жест конфликтует с прокруткой
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 5 } }),
  );

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const results = await Promise.all(COLUMNS.map(fetchColumn));
      const next = {} as Record<LeadStatus, Lead[]>;
      COLUMNS.forEach((s, i) => { next[s] = results[i]; });
      setColumns(next);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Не удалось загрузить лиды');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const allLeads = useMemo(
    () => columns ? COLUMNS.flatMap(s => columns[s]) : [],
    [columns],
  );

  const handleDragStart = (e: DragStartEvent) => {
    const lead = allLeads.find(l => l.id === e.active.id) ?? null;
    setActiveLead(lead);
  };

  const handleDragEnd = async (e: DragEndEvent) => {
    setActiveLead(null);
    const leadId = String(e.active.id);
    const targetStatus = e.over?.id as LeadStatus | undefined;
    if (!targetStatus || !columns) return;

    const fromStatus = COLUMNS.find(s => columns[s].some(l => l.id === leadId));
    if (!fromStatus || fromStatus === targetStatus) return;

    // Оптимистично двигаем карточку; при отказе PATCH — возвращаем на место.
    setColumns(prev => prev && moveBetweenColumns(prev, leadId, fromStatus, targetStatus));
    setMovingId(leadId);
    try {
      const res = await fetch(`/api/leads/${leadId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: targetStatus }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      setColumns(prev => prev && moveBetweenColumns(prev, leadId, targetStatus, fromStatus));
      setLoadError('Не удалось сохранить статус — попробуй ещё раз');
    } finally {
      setMovingId(null);
    }
  };

  if (loadError && !columns) {
    return (
      <div
        className="flex items-start gap-3 p-4 rounded-lg border"
        style={{
          borderColor: 'color-mix(in srgb, var(--danger) 30%, transparent)',
          background: 'color-mix(in srgb, var(--danger) 8%, transparent)',
        }}
      >
        <AlertTriangle size={18} className="shrink-0 mt-0.5" style={{ color: 'var(--danger)' }} />
        <p className="text-sm text-[var(--text-primary)]">{loadError}</p>
      </div>
    );
  }

  if (!columns) {
    return (
      <div className="flex gap-3 overflow-x-auto pb-2">
        {COLUMNS.map(s => <div key={s} className="ds-skeleton w-72 h-64 rounded-lg shrink-0" />)}
      </div>
    );
  }

  return (
    <div>
      {loadError && (
        <p className="text-xs mb-2" style={{ color: 'var(--danger)' }}>{loadError}</p>
      )}
      <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        <div className="flex gap-3 overflow-x-auto pb-2">
          {COLUMNS.map(status => (
            <KanbanColumn key={status} status={status} leads={columns[status]} />
          ))}
        </div>
        <DragOverlay>
          {activeLead ? (
            <div className="ds-card rounded-lg p-3 shadow-lg w-72" style={{ opacity: movingId ? 0.7 : 1 }}>
              <span className="font-medium text-sm text-[var(--text-primary)]">{activeLead.name}</span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
