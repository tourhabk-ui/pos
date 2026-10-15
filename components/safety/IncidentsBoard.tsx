import { AlertTriangle, MapPin, ShieldQuestion, CloudOff } from 'lucide-react';
import { alertSeverityWord } from '@/lib/safety/severity-words';
import { kamchatkaStamp, recomputeIsStale } from '@/lib/safety/place-day-status';

export interface IncidentAlert {
  place_name: string;
  alert_message: string | null;
  alert_severity: number;
  active_alerts: string[] | null;
  ark_id: string;
}

export interface IncidentClosedPlace {
  place_name: string;
  closed_reason: string | null;
  ark_id: string;
}

interface Props {
  /** null — база не ответила (причина в логе); [] — предупреждений нет. */
  alerts: IncidentAlert[] | null;
  closed: IncidentClosedPlace[] | null;
  /** Последний пересчёт сводок (ISO с поясом); null — не записан или не прочитан. */
  recomputedAt: string | null;
  now?: number;
}

/**
 * Доска «Обстановка» — что платформа знает о предупреждениях и закрытиях
 * (15.10, §0 «честность»).
 *
 * До этого дня страница говорила больше, чем знает:
 *   - уровни 1/2/3 подписывались «Низкий / Средний / Высокий», а у источника
 *     это «предупреждение / опасно / чрезвычайная ситуация»
 *     (lib/safety/severity-words.ts): критичное выглядело серединой;
 *   - пустой список закрытий подписывался «Все маршруты открыты по данным
 *     платформы» зелёным щитом, а закрытие — отметка администратора, и её
 *     отсутствие ничего не проверяет;
 *   - отказ базы глушился в пустой список, и сбой читался как «предупреждений
 *     нет» — третий исход выдавался за первый (§4.0).
 */
export default function IncidentsBoard({ alerts, closed, recomputedAt, now }: Props) {
  const stale = recomputeIsStale(recomputedAt, now);
  const freshness = !recomputedAt || !Number.isFinite(Date.parse(recomputedAt))
    ? 'Когда пересчитывали сводки — у нас не записано.'
    : stale
      ? `Пересчёт сводок встал: последний — ${kamchatkaStamp(recomputedAt!)} по Камчатке. Список ниже может быть уже не про сегодня.`
      : `Сводки пересчитаны ${kamchatkaStamp(recomputedAt!)} по Камчатке.`;

  return (
    <>
      <section className="px-6 pb-10">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-[10px] font-semibold uppercase tracking-widest text-[var(--text-muted)] mb-2">
            Активные предупреждения
          </h2>
          <p className={`text-xs mb-4 ${stale ? 'text-[var(--warning)]' : 'text-[var(--text-muted)]'}`}>{freshness}</p>

          {alerts === null ? (
            <Failed what="Предупреждения" />
          ) : alerts.length > 0 ? (
            <ul className="space-y-3">
              {alerts.map((a) => {
                const word = alertSeverityWord(a.alert_severity);
                const danger = a.alert_severity >= 2;
                return (
                  <li
                    key={`${a.ark_id}-${a.alert_severity}`}
                    className={`ds-card p-4 border-l-4 ${danger ? 'border-[var(--danger)] bg-[var(--danger)]/10' : 'border-[var(--warning)] bg-[var(--warning)]/10'}`}
                  >
                    <div className="flex items-start justify-between gap-4 mb-1">
                      <div className="flex items-center gap-2">
                        <MapPin className="w-4 h-4 text-[var(--accent)] shrink-0" aria-hidden />
                        <span className="font-semibold text-[var(--text-primary)] text-sm">{a.place_name}</span>
                      </div>
                      <span className={`text-xs font-semibold ${danger ? 'text-[var(--danger)]' : 'text-[var(--warning)]'}`}>
                        {word.charAt(0).toUpperCase() + word.slice(1)}
                      </span>
                    </div>
                    {a.alert_message && (
                      <p className="text-sm text-[var(--text-secondary)] ml-6 leading-relaxed">{a.alert_message}</p>
                    )}
                    {(a.active_alerts?.length ?? 0) > 0 && (
                      <div className="mt-2 ml-6 flex flex-wrap gap-1.5">
                        {a.active_alerts!.map((tag) => (
                          <span key={tag} className="text-[10px] bg-[var(--bg-hover)] text-[var(--text-secondary)] px-2 py-0.5 rounded">
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="ds-card p-6 text-center">
              <ShieldQuestion className="w-8 h-8 text-[var(--text-muted)] mx-auto mb-3" aria-hidden />
              <p className="font-semibold text-[var(--text-primary)]">В сводках предупреждений по местам нет</p>
              <p className="text-sm text-[var(--text-secondary)] mt-1">
                Это пересчёт лент предупреждений, а не проверка троп: погоду и обстановку проверяйте перед выходом.
              </p>
            </div>
          )}
        </div>
      </section>

      <section className="px-6 pb-10 border-t border-[var(--border)] pt-10">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-[10px] font-semibold uppercase tracking-widest text-[var(--text-muted)] mb-4">
            Временно закрытые места
          </h2>

          {closed === null ? (
            <Failed what="Закрытые места" />
          ) : closed.length > 0 ? (
            <ul className="space-y-2">
              {closed.map((c) => (
                <li key={c.ark_id} className="ds-card p-4 flex items-start gap-3">
                  <AlertTriangle className="w-4 h-4 text-[var(--warning)] shrink-0 mt-0.5" aria-hidden />
                  <div>
                    <p className="font-semibold text-[var(--text-primary)] text-sm">{c.place_name}</p>
                    <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                      {c.closed_reason ?? 'Причина не записана — уточните у МЧС.'}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="ds-card p-6 text-center">
              <ShieldQuestion className="w-8 h-8 text-[var(--text-muted)] mx-auto mb-3" aria-hidden />
              <p className="font-semibold text-[var(--text-primary)]">Закрытых мест не отмечено</p>
              <p className="text-sm text-[var(--text-secondary)] mt-1">
                Место закрывает администратор платформы по сообщению МЧС или дирекции парка. Нет отметки — не значит,
                что место проверено и открыто.
              </p>
            </div>
          )}
        </div>
      </section>
    </>
  );
}

function Failed({ what }: { what: string }) {
  return (
    <div className="ds-card p-6 text-center" role="alert">
      <CloudOff className="w-8 h-8 text-[var(--warning)] mx-auto mb-3" aria-hidden />
      <p className="font-semibold text-[var(--text-primary)]">{what} не загрузились</p>
      <p className="text-sm text-[var(--text-secondary)] mt-1">
        Это сбой у нас, а не «всё спокойно». Обстановку уточните у МЧС: 112.
      </p>
    </div>
  );
}
