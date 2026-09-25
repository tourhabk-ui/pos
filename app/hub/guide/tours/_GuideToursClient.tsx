'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Protected } from '@/components/auth/Protected';
import {
  Map, Clock, Users, Loader2, AlertCircle, Calendar, Phone, RefreshCw, UserPlus, ClipboardList,
} from 'lucide-react';
/**
 * Подписи — из единого словаря (lib/tours/labels). Здесь `boat_trip` называли
 * «Сплав / лодка», хотя сплав — это `rafting`: гид и турист видели один тур
 * под разными именами.
 */
import { activityLabel } from '@/lib/tours/labels';
import { plural } from '@/lib/home/data-freshness';

/**
 * «Мои туры» гида — туры оператора, в команде которого он состоит, и сколько
 * предстоящих броней каждого тура назначено ему (GET /api/guide/tours).
 *
 * До 25.09 гид без оператора видел здесь ВСЕ туры платформы под заголовком
 * «Мои туры», а привязанный — ошибку (500 на uuid = bigint). Теперь три
 * честных состояния: не удалось загрузить / вы пока не в команде / туры.
 */
interface GuideTour {
  id: string;
  title: string;
  activityType: string | null;
  durationHours: number | null;
  basePrice: number | null;
  maxParticipants: number | null;
  futureSlots: number;
  myAssignments: number;
}

interface Operator { id: string; name: string | null; phone: string | null }

function fmt(price: number) {
  return price.toLocaleString('ru-RU') + ' ₽';
}

export default function GuideToursClient() {
  const [tours, setTours] = useState<GuideTour[]>([]);
  const [operator, setOperator] = useState<Operator | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/guide/tours');
      const json = await res.json();
      if (!res.ok || !json.success) {
        setError(json.error || 'Не удалось загрузить туры');
        return;
      }
      setTours(json.data.tours ?? []);
      setOperator(json.data.operator ?? null);
    } catch {
      setError('Сеть недоступна. Туры не загружены.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <Protected roles={['guide', 'admin']}>
      <div className="max-w-5xl mx-auto p-6 space-y-6">
        <div>
          <h1 className="ds-h1 flex items-center gap-2">
            <Map className="w-6 h-6 text-[var(--ocean)]" />
            Мои туры
          </h1>
          {operator && (
            <p className="text-[var(--text-secondary)] text-sm mt-1 flex flex-wrap items-center gap-2">
              Туры оператора {operator.name ?? 'без названия'}
              {operator.phone && (
                <a href={`tel:${operator.phone}`} className="inline-flex items-center gap-1 text-[var(--ocean)] hover:underline">
                  <Phone className="w-3.5 h-3.5" /> {operator.phone}
                </a>
              )}
            </p>
          )}
        </div>

        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-[var(--accent)]" />
          </div>
        ) : error ? (
          <div className="ds-card p-4 flex items-start gap-3">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-[var(--danger)]" />
            <div className="flex-1 min-w-0 text-sm">
              <p className="font-medium text-[var(--text-primary)]">{error}</p>
              <p className="text-[var(--text-secondary)] mt-0.5">Список не показан — мы не знаем, какие туры у вас есть.</p>
            </div>
            <button type="button" onClick={() => void load()} className="ds-btn ds-btn-secondary inline-flex items-center gap-1.5 shrink-0">
              <RefreshCw className="w-4 h-4" /> Повторить
            </button>
          </div>
        ) : !operator ? (
          <div className="ds-card p-8 text-center space-y-3">
            <UserPlus className="w-10 h-10 mx-auto text-[var(--text-muted)]" />
            <p className="font-semibold text-[var(--text-primary)]">Вы пока не в команде оператора</p>
            <p className="text-sm text-[var(--text-secondary)] max-w-md mx-auto">
              Туры и назначения появятся, когда оператор пригласит вас по e-mail вашего аккаунта,
              а вы примете приглашение на странице «Обзор».
            </p>
            <Link href="/hub/guide" className="ds-btn ds-btn-secondary inline-flex">К приглашениям</Link>
          </div>
        ) : tours.length === 0 ? (
          <div className="ds-card p-10 text-center text-[var(--text-secondary)]">
            У оператора пока нет опубликованных туров
          </div>
        ) : (
          <div className="grid gap-4">
            {tours.map((tour) => (
              <div key={tour.id} className="ds-card p-5 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <h2 className="font-semibold text-[var(--text-primary)] leading-snug flex-1 min-w-0">{tour.title}</h2>
                  {tour.activityType && (
                    <span className="ds-badge shrink-0 text-xs">{activityLabel(tour.activityType)}</span>
                  )}
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm text-[var(--text-secondary)]">
                  {tour.durationHours !== null && (
                    <div className="flex items-center gap-1.5">
                      <Clock className="w-3.5 h-3.5 text-[var(--ocean)]" /> {tour.durationHours} ч
                    </div>
                  )}
                  {tour.maxParticipants !== null && (
                    <div className="flex items-center gap-1.5">
                      <Users className="w-3.5 h-3.5 text-[var(--ocean)]" /> до {tour.maxParticipants} чел
                    </div>
                  )}
                  {tour.basePrice !== null && (
                    <div className="flex items-center gap-1.5">{fmt(tour.basePrice)} / чел</div>
                  )}
                  <div className="flex items-center gap-1.5">
                    <Calendar className="w-3.5 h-3.5 text-[var(--ocean)]" />
                    {tour.futureSlots > 0
                      ? <span>{tour.futureSlots} {plural(tour.futureSlots, 'дата', 'даты', 'дат')}</span>
                      : <span className="text-[var(--text-muted)]">дат нет</span>}
                  </div>
                </div>

                {tour.myAssignments > 0 && (
                  <Link
                    href="/hub/guide/groups"
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--accent)] hover:underline"
                  >
                    <ClipboardList className="w-3.5 h-3.5" />
                    Вы назначены на {tour.myAssignments} {plural(tour.myAssignments, 'бронь', 'брони', 'броней')}
                  </Link>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </Protected>
  );
}
