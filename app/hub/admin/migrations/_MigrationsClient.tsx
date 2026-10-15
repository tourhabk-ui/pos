'use client';

/**
 * Миграции БД — экран только для чтения (аудит 15.10, находка P4-04).
 *
 * Прежде здесь была кнопка «Применить миграции» с обещанием «Идемпотентно —
 * повторный запуск безопасен». Обещание было ложным: накат через HTTP не
 * отмечал файлы в `_migrations`, и следующий деплой катил их второй раз —
 * миграция данных без ON CONFLICT удваивала строки. CLAUDE.md: «НИКОГДА не
 * применять миграции через HTTP endpoint». Применяет только деплой; здесь —
 * что не применено и почему, из `GET /api/admin/migrations/status`.
 */

import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle, Database, RefreshCw, XCircle } from 'lucide-react';

interface UnappliedMigration {
  name: string;
  error: string | null;
  attempts: number | null;
  last_failed_at: string | null;
}

interface MigrationFailure {
  name: string;
  error: string;
  attempts: number;
  last_failed_at: string | null;
}

interface StatusPayload {
  success: true;
  files_total: number;
  applied_total: number;
  unapplied: UnappliedMigration[];
  other_failures: MigrationFailure[];
  reasons_known: boolean;
  failures_error: string | null;
}

function isStatusPayload(v: unknown): v is StatusPayload {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return o.success === true
    && typeof o.files_total === 'number'
    && typeof o.applied_total === 'number'
    && Array.isArray(o.unapplied)
    && Array.isArray(o.other_failures)
    && typeof o.reasons_known === 'boolean';
}

function kamchatkaTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('ru-RU', { timeZone: 'Asia/Kamchatka', dateStyle: 'short', timeStyle: 'short' });
}

function FailureMeta({ attempts, lastFailedAt }: { attempts: number | null; lastFailedAt: string | null }) {
  const when = kamchatkaTime(lastFailedAt);
  if (attempts === null && !when) return null;
  return (
    <p className="text-xs text-[var(--text-muted)] mt-1">
      {attempts !== null && <>Попыток: {attempts}</>}
      {attempts !== null && when && ' · '}
      {when && <>последняя {when} по Камчатке</>}
    </p>
  );
}

export default function MigrationsClient() {
  const [data, setData] = useState<StatusPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  // Загрузка — внутри эффекта, «грузится» ставится в обработчике повтора, а
  // не синхронно в теле эффекта (react-hooks/set-state-in-effect).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/admin/migrations/status', { cache: 'no-store' });
        const json: unknown = await res.json().catch(() => null);
        if (!res.ok || !isStatusPayload(json)) {
          const msg = typeof json === 'object' && json !== null && typeof (json as { error?: unknown }).error === 'string'
            ? (json as { error: string }).error
            : `HTTP ${res.status}`;
          throw new Error(msg);
        }
        if (cancelled) return;
        setError(null);
        setData(json);
      } catch (e) {
        // Отказ проверки называется отказом, а не «всё применено».
        if (!cancelled) {
          setData(null);
          setError(e instanceof Error ? e.message : 'Ошибка запроса');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [tick]);

  const refresh = (): void => { setLoading(true); setTick((t) => t + 1); };

  return (
    <div className="ds-page max-w-3xl">
      <div className="flex items-start justify-between gap-4 flex-wrap mb-6">
        <div className="flex items-center gap-3">
          <Database size={28} className="text-[var(--accent)]" aria-hidden />
          <h1 className="ds-h1">Миграции базы данных</h1>
        </div>
        <button type="button" onClick={refresh} className="ds-btn ds-btn-secondary inline-flex items-center gap-2" disabled={loading}>
          <RefreshCw size={16} aria-hidden />
          Обновить
        </button>
      </div>

      <div className="ds-card p-6 mb-6">
        <p className="text-[var(--text-secondary)] text-sm leading-relaxed">
          Миграции применяет только деплой: перед стартом сервера <code className="bg-[var(--bg-hover)] px-1.5 py-0.5 rounded text-xs">start.js</code> запускает{' '}
          <code className="bg-[var(--bg-hover)] px-1.5 py-0.5 rounded text-xs">scripts/migrate-standalone.js</code>,
          и миграция, упавшая на выкате, повторяется на следующем. Отсюда их применить нельзя: ручной накат
          через админку не отмечал файлы в журнале <code className="bg-[var(--bg-hover)] px-1.5 py-0.5 rounded text-xs">_migrations</code>,
          и следующий деплой катил их второй раз. Здесь — только что не применено и почему.
        </p>
      </div>

      {loading && (
        <div className="grid gap-3" aria-busy="true">
          {[0, 1, 2].map((i) => <div key={i} className="ds-skeleton h-14 rounded-lg" />)}
        </div>
      )}

      {error && !loading && (
        <div className="ds-card p-4 border border-[var(--danger)]" role="alert">
          <p className="text-[var(--danger)] text-sm font-medium flex items-center gap-2">
            <XCircle size={16} aria-hidden />
            Состояние миграций не прочитано
          </p>
          <p className="text-sm text-[var(--text-secondary)] mt-1">{error}</p>
          <p className="text-xs text-[var(--text-muted)] mt-2">
            Это отказ проверки, а не «всё применено»: что с миграциями, сейчас неизвестно.
          </p>
        </div>
      )}

      {data && !loading && !error && (
        <div className="space-y-6">
          <p className="text-sm text-[var(--text-secondary)]">
            Файлов в каталоге: {data.files_total} · применено: {data.applied_total} · не применено: {data.unapplied.length}
          </p>

          {!data.reasons_known && (
            <div className="ds-card p-4 border border-[var(--warning)]" role="status">
              <p className="text-sm text-[var(--warning)] font-medium flex items-center gap-2">
                <AlertTriangle size={16} aria-hidden />
                Причины падений не прочитаны
              </p>
              <p className="text-xs text-[var(--text-secondary)] mt-1">
                Таблица _migration_failures не ответила{data.failures_error ? `: ${data.failures_error}` : ''}. Причины
                неизвестны, а не отсутствуют.
              </p>
            </div>
          )}

          {data.unapplied.length === 0 ? (
            <div className="ds-card p-4">
              <p className="text-sm text-[var(--success)] font-medium flex items-center gap-2">
                <CheckCircle size={16} aria-hidden />
                Все {data.files_total} файлов каталога отмечены в _migrations
              </p>
            </div>
          ) : (
            <section className="ds-card p-6">
              <h2 className="ds-h2 mb-1">Не применены</h2>
              <p className="text-xs text-[var(--text-muted)] mb-4">В том порядке, в каком их покатит следующий деплой.</p>
              <ul className="space-y-3">
                {data.unapplied.map((m) => (
                  <li key={m.name} className="py-2 border-b border-[var(--border)] last:border-0">
                    <p className="text-sm font-medium text-[var(--text-primary)] break-all">{m.name}</p>
                    {m.error !== null ? (
                      <>
                        <p className="text-xs text-[var(--danger)] mt-1 break-words">{m.error}</p>
                        <FailureMeta attempts={m.attempts} lastFailedAt={m.last_failed_at} />
                      </>
                    ) : data.reasons_known ? (
                      <p className="text-xs text-[var(--text-muted)] mt-1">
                        Записи о падении нет: миграция ещё не запускалась либо раннер остановлен раньше, чем записал
                        причину. Смотри лог деплоя, строки «[migrate]».
                      </p>
                    ) : (
                      <p className="text-xs text-[var(--text-muted)] mt-1">Причина неизвестна: таблица причин не прочитана.</p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {data.other_failures.length > 0 && (
            <section className="ds-card p-6">
              <h2 className="ds-h2 mb-1">Записи о падении у других файлов</h2>
              <p className="text-xs text-[var(--text-muted)] mb-4">
                Файл уже отмечен применённым или его нет в каталоге, а запись о падении осталась. Сторож будит по ней —
                поэтому она видна и здесь.
              </p>
              <ul className="space-y-3">
                {data.other_failures.map((f) => (
                  <li key={f.name} className="py-2 border-b border-[var(--border)] last:border-0">
                    <p className="text-sm font-medium text-[var(--text-primary)] break-all">{f.name}</p>
                    <p className="text-xs text-[var(--danger)] mt-1 break-words">{f.error}</p>
                    <FailureMeta attempts={f.attempts} lastFailedAt={f.last_failed_at} />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
