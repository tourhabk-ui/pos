'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  DataTable,
  Pagination,
  StatusBadge,
  LoadingSpinner,
  EmptyState,
  Column,
} from '@/components/admin/shared';
import { Star, BedDouble } from 'lucide-react';

/**
 * Модерация отзывов о жилье (accommodation_reviews). Отзывы гостей
 * публикуются сразу (is_visible=true); здесь админ может скрыть спам/абьюз
 * (рейтинг объекта пересчитывается на бэкенде). Зеркало страницы модерации
 * отзывов туров, по таблице accommodation_reviews.
 */

interface AdminStayReview {
  id: string;
  accommodation_id: string;
  user_name: string | null;
  accommodation_name: string | null;
  overall_rating: number;
  comment: string | null;
  is_visible: boolean;
  created_at: string;
}

export default function StayReviewsModeration() {
  const [reviews, setReviews] = useState<AdminStayReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [totalPages, setTotalPages] = useState(1);
  const [currentPage, setCurrentPage] = useState(1);
  const [visibleFilter, setVisibleFilter] = useState('all');
  const [busyId, setBusyId] = useState<string | null>(null);

  const fetchReviews = useCallback(async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams({ page: String(currentPage), limit: '20' });
      if (visibleFilter !== 'all') params.append('visible', visibleFilter);
      const res = await fetch(`/api/admin/content/accommodation-reviews?${params}`);
      const result = await res.json();
      if (result.success) {
        setReviews(result.data.reviews);
        setTotalPages(result.data.pagination.totalPages);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [currentPage, visibleFilter]);

  useEffect(() => { fetchReviews(); }, [fetchReviews]);

  const moderate = async (id: string, action: 'hide' | 'show') => {
    setBusyId(id);
    try {
      const res = await fetch(`/api/admin/content/accommodation-reviews/${id}/moderate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (res.ok) fetchReviews();
    } catch {
      // ignore
    } finally {
      setBusyId(null);
    }
  };

  const columns: Column<AdminStayReview>[] = [
    { key: 'user_name', title: 'Гость', render: r => <span className="text-[var(--text-primary)]">{r.user_name || '—'}</span> },
    { key: 'accommodation_name', title: 'Объект', render: r => <span className="text-[var(--text-secondary)]">{r.accommodation_name || '—'}</span> },
    {
      key: 'overall_rating', title: 'Оценка',
      render: r => (
        <div className="flex">
          {[...Array(5)].map((_, i) => (
            <Star key={`s-${i}`} className={`w-3.5 h-3.5 ${i < r.overall_rating ? 'text-yellow-400 fill-yellow-400' : 'text-[var(--text-muted)]/30'}`} strokeWidth={1.5} />
          ))}
        </div>
      ),
    },
    { key: 'comment', title: 'Комментарий', render: r => <p className="text-[var(--text-secondary)] max-w-md truncate text-xs">{r.comment || '—'}</p> },
    { key: 'is_visible', title: 'Статус', render: r => <StatusBadge status={r.is_visible ? 'success' : 'error'} /> },
    {
      key: 'created_at', title: 'Дата',
      render: r => <span className="text-[var(--text-muted)] text-xs font-mono">{new Date(r.created_at).toLocaleDateString('ru-RU')}</span>,
    },
    {
      key: 'actions', title: 'Действия',
      render: r => (
        r.is_visible ? (
          <button onClick={() => moderate(r.id, 'hide')} disabled={busyId === r.id}
            className="px-2.5 py-1 bg-[var(--danger)]/10 hover:bg-[var(--danger)]/20 text-[var(--danger)] rounded text-[10px] font-medium transition-colors disabled:opacity-50">
            Скрыть
          </button>
        ) : (
          <button onClick={() => moderate(r.id, 'show')} disabled={busyId === r.id}
            className="px-2.5 py-1 bg-[var(--success)]/10 hover:bg-[var(--success)]/20 text-[var(--success)] rounded text-[10px] font-medium transition-colors disabled:opacity-50">
            Показать
          </button>
        )
      ),
    },
  ];

  return (
    <div className="p-5 lg:p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <BedDouble className="w-4 h-4 text-[var(--text-muted)]" />
          <h1 className="text-sm font-semibold text-[var(--text-primary)] tracking-tight">Модерация отзывов о жилье</h1>
        </div>
        <select
          value={visibleFilter}
          onChange={e => { setVisibleFilter(e.target.value); setCurrentPage(1); }}
          className="px-3 py-1.5 text-xs bg-[var(--bg-card)] border border-[var(--border)] rounded-md text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
        >
          <option value="all">Все отзывы</option>
          <option value="true">Видимые</option>
          <option value="false">Скрытые</option>
        </select>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <LoadingSpinner size="lg" message="Загрузка отзывов..." />
        </div>
      ) : reviews.length === 0 ? (
        <EmptyState title="Отзывы не найдены" description="Отзывов о жилье для модерации пока нет" />
      ) : (
        <div className="space-y-4">
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg overflow-hidden">
            <DataTable columns={columns} data={reviews} />
          </div>
          <Pagination currentPage={currentPage} totalPages={totalPages} onPageChange={setCurrentPage} />
        </div>
      )}
    </div>
  );
}
