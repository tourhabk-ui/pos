'use client';

/**
 * Страница брифинга — то, что видит человек вне маршрута (план FCN, этап 5).
 *
 * Одна задача: он должен понять, кого и когда ждать и что делать, если не
 * дождался. Поэтому главная цифра — время возврата, а не красивая карточка
 * маршрута. Никакой карты с точкой «где сейчас»: положения мы не знаем и
 * знать не обещаем.
 *
 * Страница честна в трёх местах: возраст снимка виден; «время возврата
 * прошло» говорится словами вместе с инструкцией; просроченная и отозванная
 * ссылки различаются, а не сваливаются в общий 404.
 */

import { useEffect, useState } from 'react';
import { AlertTriangle, Clock, Info, MapPin, Phone, Users } from 'lucide-react';
import { overdueGuidance, type BriefingSnapshot } from '@/lib/preparation/briefing';
import { EmergencyAction } from '@/components/shared/EmergencyAction';

const DURATION_LABEL: Record<string, string> = {
  under_4h: 'до 4 часов', day: 'один день', overnight: 'с ночёвкой', multi_day: 'несколько дней',
};
const PARTY_LABEL: Record<string, string> = {
  solo: 'один', group: 'группа', guided: 'с гидом',
};
const PACK_LABEL: Record<BriefingSnapshot['packReadiness'], string> = {
  ready: 'карта и точки сохранены в телефоне',
  partial: 'полевой пакет сохранён не полностью',
  not_ready: 'полевой пакет не сохранён',
  unknown: 'о полевом пакете данных нет',
};

function fmtDateTime(iso: string | null): string | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return null;
  return new Date(ts).toLocaleString('ru-RU', {
    day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
  });
}

function fmtDate(iso: string | null): string | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return null;
  return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

export default function BriefingClient({ token }: { token: string }) {
  const [snapshot, setSnapshot] = useState<BriefingSnapshot | null>(null);
  const [meta, setMeta] = useState<{ sharedAt: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<{ text: string; reason?: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/preparation/share/${token}`)
      .then(async r => ({ ok: r.ok, body: await r.json() as Record<string, unknown> }))
      .then(({ ok, body }) => {
        if (!ok || body.success !== true) {
          setError({
            text: typeof body.error === 'string' ? body.error : 'Брифинг недоступен',
            reason: typeof body.reason === 'string' ? body.reason : undefined,
          });
          return;
        }
        const data = body.data as { snapshot: BriefingSnapshot; sharedAt: string; expiresAt: string };
        setSnapshot(data.snapshot);
        setMeta({ sharedAt: data.sharedAt, expiresAt: data.expiresAt });
      })
      .catch(() => setError({ text: 'Не удалось загрузить брифинг — проверьте связь' }))
      .finally(() => setLoading(false));
  }, [token]);

  if (loading) {
    return (
      <div className="ds-page max-w-lg mx-auto px-4 py-10">
        <div className="ds-skeleton h-6 w-48 mb-3" />
        <div className="ds-skeleton h-24 w-full" />
      </div>
    );
  }

  if (error || !snapshot) {
    return (
      <div className="ds-page max-w-lg mx-auto px-4 py-10">
        <h1 className="ds-h2 mb-2">Брифинг недоступен</h1>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          {error?.text ?? 'Брифинг не найден'}
        </p>
        {error?.reason === 'expired' && (
          <p className="text-sm mt-3" style={{ color: 'var(--text-muted)' }}>
            Ссылки на брифинг живут ограниченное время. Если поход ещё предстоит,
            попросите участника создать новую.
          </p>
        )}
        <p className="text-sm mt-4" style={{ color: 'var(--text-secondary)' }}>
          Если вы беспокоитесь о человеке прямо сейчас — экстренный телефон 112.
        </p>
      </div>
    );
  }

  const overdue = overdueGuidance(snapshot.returnBy);
  const returnAt = fmtDateTime(snapshot.returnBy);
  const departure = fmtDate(snapshot.departureAt);
  const takenAt = fmtDateTime(snapshot.takenAt);

  return (
    <div className="ds-page max-w-lg mx-auto px-4 py-6 pb-16">
      <p className="ds-label mb-1">Брифинг похода</p>
      <h1 className="ds-h1 mb-1">{snapshot.routeTitle}</h1>
      <p className="text-sm mb-5" style={{ color: 'var(--text-secondary)' }}>
        {[departure && `выход ${departure}`,
          snapshot.duration ? DURATION_LABEL[snapshot.duration] : null,
          snapshot.party ? PARTY_LABEL[snapshot.party] : null,
        ].filter(Boolean).join(' · ')}
      </p>

      {/* Главное число брифинга — время возврата. По нему человек снаружи
          принимает единственное решение, которое от него зависит. */}
      <div className="ds-card p-4 mb-4">
        <div className="flex items-center gap-2 mb-1">
          <Clock className="w-4 h-4" style={{ color: 'var(--ocean)' }} />
          <p className="ds-label" style={{ margin: 0 }}>Ждать обратно</p>
        </div>
        {returnAt ? (
          <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{returnAt}</p>
        ) : (
          <p className="text-sm" style={{ color: 'var(--warning)' }}>
            Время возврата не указано — уточните у участника
          </p>
        )}
      </div>

      {overdue && (
        <div className="ds-card p-4 mb-4"
          style={{ borderColor: 'var(--danger)', background: 'color-mix(in srgb, var(--danger) 8%, var(--bg-card))' }}>
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--danger)' }} />
            <p className="text-sm" style={{ color: 'var(--text-primary)' }}>{overdue}</p>
          </div>
        </div>
      )}

      <div className="ds-card p-4 mb-4 space-y-2 text-sm">
        <div className="flex items-start gap-2">
          <MapPin className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--text-muted)' }} />
          <span style={{ color: 'var(--text-secondary)' }}>
            {snapshot.routeGrade} · {snapshot.waypointsCount} точек · редакция маршрута v{snapshot.routeVersion}
          </span>
        </div>
        <div className="flex items-start gap-2">
          <Users className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--text-muted)' }} />
          <span style={{ color: 'var(--text-secondary)' }}>
            Подготовка: {snapshot.preparedDomains} из {snapshot.totalDomains} доменов · {PACK_LABEL[snapshot.packReadiness]}
          </span>
        </div>
        {snapshot.openActions.length > 0 && (
          <div className="flex items-start gap-2">
            <Info className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--text-muted)' }} />
            <span style={{ color: 'var(--text-secondary)' }}>
              На момент отправки не закрыто: {snapshot.openActions.join(', ')}
            </span>
          </div>
        )}
      </div>

      {/* Граница обещания. Без этой строки страница читается как трекер. */}
      <div className="ds-card p-4 mb-4">
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          Это <strong>снимок плана</strong>, а не слежение: положение участника здесь не
          показывается и платформе неизвестно. Данные на {takenAt ?? 'момент отправки'} и
          с тех пор не менялись.
        </p>
      </div>

      <EmergencyAction className="ds-btn ds-btn-danger w-full flex items-center justify-center gap-2">
        <Phone className="w-4 h-4" /> 112 — экстренный вызов
      </EmergencyAction>
      <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
        Сообщите диспетчеру название маршрута, дату выхода и планового возврата с этой страницы.
      </p>
      {meta && (
        <p className="text-xs mt-4" style={{ color: 'var(--text-muted)' }}>
          Ссылка действует до {fmtDateTime(meta.expiresAt)}
        </p>
      )}
    </div>
  );
}
