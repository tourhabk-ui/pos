'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import {
  DndContext, PointerSensor, TouchSensor, useSensor, useSensors,
  useDraggable, useDroppable, DragOverlay,
  type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core';
import { Phone, AlertTriangle } from 'lucide-react';
import { MANUAL_LEAD_STATUSES, type LeadStatus } from '@/lib/types/statuses';
import { LEADS_PAGE_MAX, leadsPageUrl } from '@/lib/leads/list-page';
import { Sensitive } from '@/components/admin/shared/Sensitive';
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

/**
 * Колонка доски: ручной статус, который ставит перенос (`key`), и статусы,
 * чьих лидов колонка показывает (`members`).
 */
export interface KanbanColumnSpec {
  key: LeadStatus;
  members: readonly LeadStatus[];
}

/** Админ: колонка = ровно свой статус (решение выше). */
export const ADMIN_COLUMNS: readonly KanbanColumnSpec[] = COLUMNS.map((s) => ({ key: s, members: [s] }));

/**
 * Оператор (CRM фаза 2, пилот): лиды конвейера лежат в колонке, куда
 * относятся по смыслу, а не пропадают с доски. У оператора почти каждый лид
 * проходит конвейер (крон обрабатывает новые), и доска только из ручных
 * статусов была бы пустой: «AI-квалифицирован» — это новый лид, которому
 * ещё не звонили; «КП отправлено» и «ждёт подтверждения» — лид в работе.
 * Колонки по-прежнему ставят только ручные статусы: перенос выводит лида
 * из статуса конвейера, но не ставит его. Точный статус виден на карточке.
 * «AI обрабатывает» не переносится: конвейер ещё пишет в эту запись.
 */
export const OPERATOR_COLUMNS: readonly KanbanColumnSpec[] = [
  { key: 'new',       members: ['new', 'ai_processing', 'ai_qualified'] },
  { key: 'contacted', members: ['contacted', 'proposal_sent', 'awaiting_confirm'] },
  { key: 'qualified', members: ['qualified'] },
  { key: 'converted', members: ['converted'] },
  { key: 'lost',      members: ['lost'] },
];

/**
 * Лиды статуса целиком — страницами по потолку роута (lib/leads/list-page.ts).
 * Конец — неполная страница или набранный счёт `total`; пустая страница тоже
 * конец, даже если счёт успел вырасти, иначе цикл ждал бы лида, которого нет.
 */
export async function fetchColumn(status: LeadStatus): Promise<Lead[]> {
  const leads: Lead[] = [];
  for (;;) {
    const res = await fetch(leadsPageUrl(status, leads.length));
    if (!res.ok) throw new Error(`status ${status}: HTTP ${res.status}`);
    const data = await res.json() as { leads: Lead[]; total?: number };
    leads.push(...data.leads);
    if (data.leads.length < LEADS_PAGE_MAX || leads.length >= (data.total ?? 0)) return leads;
  }
}

/** Лиды колонки — по всем её статусам, свежие сверху. */
async function fetchSpec(spec: KanbanColumnSpec): Promise<Lead[]> {
  const parts = await Promise.all(spec.members.map(fetchColumn));
  return parts.flat().sort((a, b) => b.created_at.localeCompare(a.created_at));
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

function KanbanCard({ lead, columnKey, href }: { lead: Lead; columnKey: LeadStatus; href?: string }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: lead.id,
    data: { lead },
    disabled: lead.status === 'ai_processing',
  });
  const exactStatus = lead.status !== columnKey ? STATUS_META[lead.status] : null;
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
        {href ? (
          <Link href={href} className="font-medium text-sm text-[var(--text-primary)] truncate hover:text-[var(--ocean)] transition-colors">
            <Sensitive>{lead.name}</Sensitive>
          </Link>
        ) : (
          <Sensitive as="span" className="font-medium text-sm text-[var(--text-primary)] truncate">{lead.name}</Sensitive>
        )}
        <ScoreBadge score={lead.ai_score} />
      </div>
      {exactStatus && (
        <span className={`inline-block mt-1 text-[10px] px-1.5 py-0.5 rounded-full font-medium ${exactStatus.color}`}>{exactStatus.label}</span>
      )}
      <div className="flex items-center gap-1 mt-1 text-xs text-[var(--text-secondary)]">
        <Phone size={11} />
        <Sensitive>{lead.phone}</Sensitive>
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

function KanbanColumn({ status, leads, cardHref }: { status: LeadStatus; leads: Lead[]; cardHref?: (lead: Lead) => string }) {
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
          leads.map(lead => <KanbanCard key={lead.id} lead={lead} columnKey={status} href={cardHref?.(lead)} />)
        )}
      </div>
    </div>
  );
}

export function LeadsKanban({ columns: specs = ADMIN_COLUMNS, cardHref }: {
  /** Колонки доски; по умолчанию — админская, по одному статусу. */
  columns?: readonly KanbanColumnSpec[];
  /** Ссылка с карточки на страницу лида. */
  cardHref?: (lead: Lead) => string;
} = {}) {
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
      const results = await Promise.all(specs.map(fetchSpec));
      const next = {} as Record<LeadStatus, Lead[]>;
      specs.forEach((spec, i) => { next[spec.key] = results[i]; });
      setColumns(next);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Не удалось загрузить лиды');
    }
  }, [specs]);

  useEffect(() => { load(); }, [load]);

  const allLeads = useMemo(
    () => columns ? specs.flatMap(spec => columns[spec.key]) : [],
    [columns, specs],
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

    const fromStatus = specs.map(spec => spec.key).find(s => columns[s].some(l => l.id === leadId));
    if (!fromStatus || fromStatus === targetStatus) return;
    // Статус до переноса — для отката: в колонке оператора лид мог стоять в
    // статусе конвейера («AI-квалифицирован»), а не в ключе колонки.
    const prevLead = columns[fromStatus].find(l => l.id === leadId);

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
      setColumns(prev => {
        if (!prev) return prev;
        const back = moveBetweenColumns(prev, leadId, targetStatus, fromStatus);
        return prevLead
          ? { ...back, [fromStatus]: back[fromStatus].map(l => (l.id === leadId ? prevLead : l)) }
          : back;
      });
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
        {specs.map(spec => <div key={spec.key} className="ds-skeleton w-72 h-64 rounded-lg shrink-0" />)}
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
          {specs.map(spec => (
            <KanbanColumn key={spec.key} status={spec.key} leads={columns[spec.key]} cardHref={cardHref} />
          ))}
        </div>
        <DragOverlay>
          {activeLead ? (
            <div className="ds-card rounded-lg p-3 shadow-lg w-72" style={{ opacity: movingId ? 0.7 : 1 }}>
              <Sensitive as="span" className="font-medium text-sm text-[var(--text-primary)]">{activeLead.name}</Sensitive>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
