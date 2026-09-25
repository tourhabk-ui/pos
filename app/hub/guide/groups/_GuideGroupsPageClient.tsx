'use client';

import { useState } from 'react';
import Link from 'next/link';
import { LoadingSpinner } from '@/components/admin/shared';
import { Users, Calendar, Phone, MapPin, AlertCircle, RefreshCw, ChevronDown, ChevronUp, UserPlus } from 'lucide-react';
import { useApiFetch } from '@/hooks/use-api-fetch';
import { formatDateOnly } from '@/lib/dates/date-only';
import { plural } from '@/lib/home/data-freshness';

/**
 * «Мои группы» — предстоящие брони, на которые гида назначил оператор,
 * собранные по дате и туру (GET /api/guide/groups).
 *
 * До 25.09 группы создавались руками на запись расписания, участников в них
 * не писал никто, а сам список отвечал 500 (uuid = bigint) и рисовался как
 * «Нет активных групп». Теперь состав и контакт туриста — из самой брони;
 * контакт видит только назначенный гид, пока он в команде оператора.
 */
interface GroupBooking {
  bookingId: string;
  status: string;
  participants: number;
  touristName: string | null;
  touristPhone: string | null;
  specialRequests: string | null;
  endDate: string | null;
}

interface Group {
  key: string;
  date: string;
  tourId: string;
  tourTitle: string;
  meetingPoint: string | null;
  operatorName: string | null;
  totalParticipants: number;
  bookings: GroupBooking[];
}

interface GroupsApiResponse { inTeam: boolean; groups: Group[] }

const STATUS_LABEL: Record<string, string> = {
  new: 'Новая', pending_payment: 'Ждёт оплаты', confirmed: 'Подтверждена',
};

export default function GuideGroupsPageClient() {
  const [expanded, setExpanded] = useState<string | null>(null);
  const { data, loading, error, refetch } = useApiFetch<GroupsApiResponse, GroupsApiResponse>(
    '/api/guide/groups',
    (d) => ({ inTeam: Boolean(d?.inTeam), groups: d?.groups ?? [] }),
    { errorMessage: 'Не удалось загрузить группы' },
  );

  const groups = data?.groups ?? [];

  return (
    <div className="p-5 lg:p-6 space-y-5">
      <div>
        <h1 className="ds-h1 flex items-center gap-2">
          <Users className="w-6 h-6 text-[var(--ocean)]" />
          Мои группы
        </h1>
        <p className="text-sm text-[var(--text-muted)] mt-0.5">
          Брони, на которые вас назначил оператор
        </p>
      </div>

      {loading ? (
        <LoadingSpinner message="Загрузка групп..." />
      ) : error ? (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4 flex items-start gap-3">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-[var(--danger)]" />
          <div className="flex-1 min-w-0 text-sm">
            <p className="font-medium text-[var(--text-primary)]">{error}</p>
            <p className="text-[var(--text-secondary)] mt-0.5">Список не показан — мы не знаем, есть ли у вас группы.</p>
          </div>
          <button type="button" onClick={() => void refetch()} className="ds-btn ds-btn-secondary inline-flex items-center gap-1.5 shrink-0">
            <RefreshCw className="w-4 h-4" /> Повторить
          </button>
        </div>
      ) : !data?.inTeam ? (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-10 text-center space-y-3">
          <UserPlus className="w-10 h-10 mx-auto text-[var(--text-muted)]" />
          <p className="text-sm font-semibold text-[var(--text-primary)]">Вы пока не в команде оператора</p>
          <p className="text-sm text-[var(--text-muted)]">Группы появятся, когда оператор примет вас в команду и назначит на бронь.</p>
          <Link href="/hub/guide" className="ds-btn ds-btn-secondary inline-flex">К приглашениям</Link>
        </div>
      ) : groups.length === 0 ? (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-12 text-center">
          <Users className="w-14 h-14 mx-auto mb-4 text-[var(--text-muted)]" />
          <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-2">Пока пусто</h2>
          <p className="text-sm text-[var(--text-muted)]">Оператор ещё не назначил вас на предстоящие брони</p>
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map((group) => {
            const open = expanded === group.key;
            return (
              <div key={group.key} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg overflow-hidden">
                <button
                  onClick={() => setExpanded(open ? null : group.key)}
                  aria-expanded={open}
                  className="w-full px-5 py-4 text-left hover:bg-[var(--bg-hover)] transition-colors"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-[var(--text-primary)]">{group.tourTitle}</h3>
                      <div className="flex flex-wrap items-center gap-4 mt-1.5 text-xs text-[var(--text-muted)]">
                        <span className="flex items-center gap-1">
                          <Calendar className="w-3.5 h-3.5" />
                          {formatDateOnly(group.date, { weekday: 'short', day: 'numeric', month: 'long' })}
                        </span>
                        <span className="flex items-center gap-1">
                          <Users className="w-3.5 h-3.5" />
                          {group.totalParticipants} {plural(group.totalParticipants, 'участник', 'участника', 'участников')}
                        </span>
                        {group.operatorName && <span>{group.operatorName}</span>}
                      </div>
                    </div>
                    {open
                      ? <ChevronUp className="w-4 h-4 shrink-0 text-[var(--text-muted)]" />
                      : <ChevronDown className="w-4 h-4 shrink-0 text-[var(--text-muted)]" />}
                  </div>
                </button>

                {open && (
                  <div className="border-t border-[var(--border)] px-5 py-4 space-y-3">
                    {group.meetingPoint && (
                      <p className="text-sm text-[var(--text-secondary)] flex items-center gap-1.5">
                        <MapPin className="w-4 h-4 text-[var(--ocean)]" /> {group.meetingPoint}
                      </p>
                    )}
                    {group.bookings.map((b) => (
                      <div key={b.bookingId} className="px-3.5 py-3 bg-[var(--bg-hover)] rounded-md space-y-1.5">
                        <div className="flex items-center justify-between gap-3 flex-wrap">
                          <span className="text-sm font-medium text-[var(--text-primary)]">
                            {b.touristName ?? 'Имя не указано'} · {b.participants} чел.
                          </span>
                          <span className="text-xs text-[var(--text-muted)]">
                            бронь #{b.bookingId} · {STATUS_LABEL[b.status] ?? b.status}
                          </span>
                        </div>
                        {b.touristPhone ? (
                          <a href={`tel:${b.touristPhone}`} className="inline-flex items-center gap-1 text-sm text-[var(--ocean)] hover:underline">
                            <Phone className="w-3.5 h-3.5" /> {b.touristPhone}
                          </a>
                        ) : (
                          <p className="text-xs text-[var(--text-muted)]">Телефон туриста не указан — уточните у оператора</p>
                        )}
                        {b.specialRequests && (
                          <p className="text-xs text-[var(--warning)]">Пожелания: {b.specialRequests}</p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
