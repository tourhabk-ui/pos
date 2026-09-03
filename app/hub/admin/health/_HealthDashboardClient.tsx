'use client';

import { useEffect, useState } from 'react';
import { Activity, FileCheck, PhoneCall, Map, Wind, LifeBuoy, AlertTriangle, CheckCircle2, Bot, Plug, Loader2, BellRing } from 'lucide-react';
import type { AlertDeliveryHealth } from '@/lib/services/safety/alert-delivery-health';

/**
 * Сводный health-дашборд данных: все /api/admin/health/* метрики на одной
 * странице + детальная сверка телефонов (issue #366) — рабочий экран для
 * сверки с Артёмом вместо чтения сырого JSON.
 * Каждая карточка живёт на своём фетче: упавший эндпоинт показывает
 * ошибку, не роняя остальные.
 */

interface PassportCoverage {
  status: string;
  reason?: string;
  total_routes: number;
  routes_with_passport: number;
  coverage_pct: number;
  empty_categories: string[];
}

interface RescueCoverage {
  totalRoutes: number;
  withRescueContacts: number;
  coveragePercent: number;
}

interface GeometryHealth {
  total: number;
  with_track: number;
  pct: number;
  ok: boolean;
}

interface AirCoverage {
  status: string;
  reason?: string;
  total_zones: number;
  zones_with_fresh_data: number;
  coverage_pct: number;
  stale_zones: string[];
  zones?: Array<{
    zone: string;
    zoneName: string;
    fresh: boolean;
    ageMinutes: number | null;
    station: { name: string; distanceKm: number | null; represents: string } | null;
    failure: string | null;
  }>;
}

/** Что цифра описывает — словами, а не кодом. */
/** Почему цифры нет — словами. «Нет станции» и «предел запросов» чинятся по-разному. */
const AIR_FAILURE_LABELS: Record<string, string> = {
  no_key: 'ключ не задан',
  no_station: 'станции рядом нет',
  rate_limited: 'предел запросов плана IQAir',
  unauthorized: 'ключ не принят провайдером',
  http_error: 'провайдер ответил отказом',
  network: 'не дозвонились',
  malformed: 'ответ без числа AQI',
};

const PROXIMITY_LABELS: Record<string, string> = {
  zone: 'воздух зоны',
  nearby: 'окрестность, не сама зона',
  distant: 'далеко — про зону не говорит',
  unknown: 'расстояние неизвестно',
};

interface GroundingHealth {
  total_graded: number;
  avg_score: number;
  low_quality_count: number;
  ungrounded_count: number;
  recent_issues: string[];
  ok: boolean;
}

interface PhonesHealth {
  total: number;
  bySource: Record<string, number>;
  byPurpose: Record<string, number>;
  discrepancies: { purpose: string; phones: { phone: string; source: string; name: string | null }[] }[];
  similarPairs: { codePhone: string; codeName: string | null; portalPhone: string; portalName: string | null; digitDiff: number }[];
  hardcodedSites: { phone: string; role: string; files: readonly string[]; sosCritical: boolean }[];
}

const SOURCE_LABELS: Record<string, string> = {
  code: 'Код приложения',
  visitkamchatka: 'Портал visitkamchatka',
  seed: 'Старый сид (происхождение неизвестно)',
  verified: 'Подтверждено',
};

const PURPOSE_LABELS: Record<string, string> = {
  emergency: 'Экстренный',
  registration: 'Регистрация маршрутов',
  consultation: 'Консультации',
  permit: 'Разрешения',
};

function useHealth<T>(url: string): { data: T | null; error: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then(r => (r.ok ? r.json() : null))
      .then((d: unknown) => {
        if (cancelled) return;
        if (d !== null) setData(d as T);
        else setError(true);
      })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [url]);

  return { data, error };
}

interface ProviderStatus {
  id: string;
  name: string;
  available: boolean;
  latency_ms?: number;
  error?: string;
}

interface PreflightData {
  providers: ProviderStatus[];
  any_available: boolean;
  openrouter_balance: { total_credits: number; total_usage: number; remaining: number | null; low: boolean } | null;
  /** Откуда спрашивали: у раннера GitHub и у прода ключи РАЗНЫЕ намеренно. */
  place?: string;
  keys?: Array<{
    id: string; label: string; env: string;
    identity: { present: boolean; format: string | null; length: number; fingerprint: string | null };
  }>;
}

const PLACE_LABELS: Record<string, string> = {
  'github-actions': 'раннер GitHub (ключи из секретов репозитория)',
  prod: 'прод Timeweb (ключи из переменных приложения)',
  local: 'локальная машина (.env.local)',
  unknown: 'место запуска не определено',
};

function StatusDot({ ok }: { ok: boolean }) {
  return ok
    ? <CheckCircle2 className="w-4 h-4 text-[var(--success)]" />
    : <AlertTriangle className="w-4 h-4 text-[var(--warning)]" />;
}

function MetricCard({
  title,
  icon: Icon,
  ok,
  error,
  loading,
  children,
}: {
  title: string;
  icon: typeof Activity;
  ok?: boolean;
  error: boolean;
  loading: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Icon className="w-4 h-4 text-[var(--text-muted)]" />
          <p className="text-sm font-semibold text-[var(--text-primary)]">{title}</p>
        </div>
        {!loading && !error && ok !== undefined && <StatusDot ok={ok} />}
      </div>
      {loading && !error && <div className="ds-skeleton h-16 rounded-lg" />}
      {error && <p className="text-xs text-[var(--danger)]">Не удалось загрузить метрику</p>}
      {!loading && !error && children}
    </div>
  );
}

function CoverageLine({ label, value, total, pct }: { label: string; value: number; total: number; pct: number }) {
  return (
    <div>
      <p className="text-2xl font-bold text-[var(--text-primary)]">{pct}%</p>
      <p className="text-xs text-[var(--text-secondary)] mt-0.5">{label}: {value} из {total}</p>
      <div className="mt-2 h-1.5 rounded-full bg-[var(--bg-hover)] overflow-hidden">
        <div className="h-full rounded-full bg-[var(--ocean)]" style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
    </div>
  );
}

export default function HealthDashboardClient() {
  const passports = useHealth<PassportCoverage>('/api/admin/health/passport-coverage');
  const rescue = useHealth<RescueCoverage>('/api/admin/health/rescue-coverage');
  const geometry = useHealth<GeometryHealth>('/api/admin/health/routes-geometry');
  const air = useHealth<AirCoverage>('/api/admin/health/air-quality-coverage');
  const grounding = useHealth<GroundingHealth>('/api/admin/health/kuzmich-grounding');
  const phones = useHealth<{ success: boolean; data: PhonesHealth }>('/api/admin/health/emergency-contacts');
  // Доставка тревог (#1485): «создана → доставлена» одним взглядом. Каждое
  // число троично — null значит «не посчитали», и точка здоровья не рисуется.
  const delivery = useHealth<{ success: boolean; data: AlertDeliveryHealth }>('/api/admin/health/alert-delivery');

  // Провайдеры ИИ проверяются ПО КНОПКЕ, а не при открытии страницы: проба
  // шлёт каждому провайдеру настоящий запрос и тратит их квоту. Состояние
  // тройное — «не проверяли» это не «всё хорошо».
  const [preflight, setPreflight] = useState<PreflightData | null>(null);
  const [preflightRunning, setPreflightRunning] = useState(false);
  const [preflightError, setPreflightError] = useState<string | null>(null);

  async function runPreflight() {
    setPreflightRunning(true);
    setPreflightError(null);
    try {
      const res = await fetch('/api/admin/health/ai-providers');
      const json = await res.json() as { success?: boolean; data?: PreflightData; error?: string };
      if (!res.ok || json.success !== true || !json.data) {
        setPreflightError(json.error ?? `Ответ ${res.status}`);
      } else {
        setPreflight(json.data);
      }
    } catch {
      setPreflightError('Запрос не ушёл — проверьте сеть');
    } finally {
      setPreflightRunning(false);
    }
  }

  const phonesData = phones.data?.data ?? null;

  return (
    <div className="p-5 lg:p-6 space-y-6">
      <div className="flex items-center gap-2.5">
        <Activity className="w-4 h-4 text-[var(--text-muted)]" />
        <h1 className="text-sm font-semibold text-[var(--text-primary)] tracking-tight">Health-метрики данных</h1>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <MetricCard title="Паспорта маршрутов" icon={FileCheck}
          ok={passports.data?.status === 'ok'} error={passports.error} loading={!passports.data}>
          {passports.data && (
            <>
              <CoverageLine label="С официальным паспортом" pct={passports.data.coverage_pct}
                value={passports.data.routes_with_passport} total={passports.data.total_routes} />
              {passports.data.reason && (
                <p className="text-xs text-[var(--warning)] mt-2">{passports.data.reason}</p>
              )}
            </>
          )}
        </MetricCard>

        <MetricCard title="Контакты МЧС у маршрутов" icon={LifeBuoy}
          ok={(rescue.data?.coveragePercent ?? 0) > 50} error={rescue.error} loading={!rescue.data}>
          {rescue.data && (
            <CoverageLine label="С телефоном МЧС" pct={rescue.data.coveragePercent}
              value={rescue.data.withRescueContacts} total={rescue.data.totalRoutes} />
          )}
        </MetricCard>

        <MetricCard title="Треки маршрутов" icon={Map}
          ok={geometry.data?.ok} error={geometry.error} loading={!geometry.data}>
          {geometry.data && (
            <CoverageLine label="С валидным треком" pct={geometry.data.pct}
              value={geometry.data.with_track} total={geometry.data.total} />
          )}
        </MetricCard>

        <MetricCard title="Доставка тревог" icon={BellRing}
          ok={delivery.data?.data.ok ?? undefined} error={delivery.error} loading={!delivery.data}>
          {delivery.data && (() => {
            const d = delivery.data.data;
            const num = (v: number | null, reason: string | null) => v === null
              ? <span className="text-[var(--warning)]">{reason ?? 'не посчитано'}</span>
              : <span className="text-[var(--text-primary)] font-semibold">{v}</span>;
            return (
              <div className="space-y-1.5 text-xs text-[var(--text-secondary)]">
                <p>Push-подписок: {num(d.subscriptions.count, d.subscriptions.reason)}</p>
                <p>
                  Сейсмо-приём: {d.last_ingest.age_minutes === null
                    ? <span className="text-[var(--warning)]">{d.last_ingest.reason ?? 'не посчитано'}</span>
                    : <span className={d.last_ingest.stale ? 'text-[var(--danger)] font-semibold' : 'text-[var(--text-primary)] font-semibold'}>
                        {d.last_ingest.age_minutes} мин назад · {d.last_ingest.status}
                      </span>}
                </p>
                <p>
                  Разослано за сутки: {num(d.notified_24h.alerts, d.notified_24h.reason)} тревог
                  {d.notified_24h.sent !== null && <> · {d.notified_24h.sent} доставок, {d.notified_24h.failed} отказов</>}
                </p>
                <p>Опасных без доставки более 30 мин: {num(d.undelivered.count, d.undelivered.reason)}</p>
                {d.ok === null && (
                  <p className="text-[var(--warning)]">Здоровье не установлено: не все числа посчитаны</p>
                )}
              </div>
            );
          })()}
        </MetricCard>

        <MetricCard title="Качество воздуха (IQAir)" icon={Wind}
          ok={air.data?.status === 'ok'} error={air.error} loading={!air.data}>
          {air.data && (
            <>
              <CoverageLine label="Зон со свежими данными" pct={air.data.coverage_pct}
                value={air.data.zones_with_fresh_data} total={air.data.total_zones} />
              {air.data.reason && (
                <p className="text-xs text-[var(--warning)] mt-2">{air.data.reason}</p>
              )}

              {/* Откуда цифра. Замер 23.08: отвечают две зоны из шести, обе
                  рядом с Петропавловском, — то есть «данные есть» без имени
                  станции вводит в заблуждение сильнее, чем помогает. */}
              {air.data.zones !== undefined && (
                <div className="mt-2 space-y-1">
                  {air.data.zones.map(z => (
                    <p key={z.zone} className="text-xs text-[var(--text-muted)] break-words">
                      {z.zoneName}:{' '}
                      {z.station === null ? (
                        <span>
                          {z.failure !== null
                            ? (AIR_FAILURE_LABELS[z.failure] ?? z.failure)
                            : z.fresh ? 'станцию источник не назвал' : 'данных нет'}
                        </span>
                      ) : (
                        <>
                          {z.station.name}
                          {z.station.distanceKm !== null && `, ${z.station.distanceKm} км`}
                          {' — '}
                          {PROXIMITY_LABELS[z.station.represents] ?? z.station.represents}
                        </>
                      )}
                    </p>
                  ))}
                </div>
              )}
            </>
          )}
        </MetricCard>

        <MetricCard title="Заземление Кузьмича" icon={Bot}
          ok={grounding.data?.ok} error={grounding.error} loading={!grounding.data}>
          {grounding.data && (
            <div>
              <p className="text-2xl font-bold text-[var(--text-primary)]">{grounding.data.ungrounded_count}</p>
              <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                Ответов с фактами без инструментов за 7 дней (оценено {grounding.data.total_graded}, средний балл {grounding.data.avg_score || '—'})
              </p>
              <p className="text-xs text-[var(--text-muted)] mt-2">
                Цены, телефоны и наличие мест должны приходить из БД, а не «из головы» модели.
              </p>
            </div>
          )}
        </MetricCard>
      </div>

      {/* Провайдеры ИИ — проба по кнопке, а не метрика */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-1">
          <div className="flex items-center gap-2">
            <Plug className="w-4 h-4 text-[var(--text-muted)]" />
            <p className="text-sm font-semibold text-[var(--text-primary)]">Провайдеры ИИ</p>
          </div>
          <button
            type="button"
            onClick={runPreflight}
            disabled={preflightRunning}
            className="ds-btn ds-btn-secondary text-xs disabled:opacity-60"
          >
            {preflightRunning && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {preflightRunning ? 'Проверяю' : 'Проверить провайдеров'}
          </button>
        </div>
        <p className="text-xs text-[var(--text-secondary)] mb-4">
          Каждому провайдеру уходит короткий настоящий запрос, поэтому проверка идёт по кнопке,
          а не при открытии страницы. Рядом — остаток OpenRouter числом, а не по обрывку чужой ошибки.
        </p>

        {preflightError && (
          <p className="text-xs text-[var(--danger)]">Проверка не выполнилась: {preflightError}</p>
        )}
        {!preflight && !preflightError && !preflightRunning && (
          <p className="text-xs text-[var(--text-muted)]">Проверка не запускалась — состояние провайдеров неизвестно.</p>
        )}
        {preflightRunning && <div className="ds-skeleton h-20 rounded-lg" />}

        {preflight && (
          <div className="space-y-4">
            {preflight.openrouter_balance ? (
              <p className={`text-xs ${preflight.openrouter_balance.low ? 'text-[var(--warning)]' : 'text-[var(--text-secondary)]'}`}>
                OpenRouter: потрачено {preflight.openrouter_balance.total_usage.toFixed(2)} из{' '}
                {preflight.openrouter_balance.total_credits.toFixed(2)}
                {preflight.openrouter_balance.remaining !== null
                  ? `, остаток ${preflight.openrouter_balance.remaining.toFixed(2)}`
                  : ', лимита нет (pay-as-you-go)'}
              </p>
            ) : (
              <p className="text-xs text-[var(--text-muted)]">Остаток OpenRouter получить не удалось.</p>
            )}

            {!preflight.any_available && (
              <p className="text-xs text-[var(--danger)]">Не ответил ни один провайдер.</p>
            )}

            {/* Ключи в GitHub и в Timeweb разные намеренно (решение владельца
                23.08). Без отпечатка два отказа выглядят одинаково, и понять,
                какой именно ключ сломан, нельзя. Отпечаток — восемь hex от
                SHA-256: ключ по нему не восстановить, а различить два ключа
                можно с первого взгляда. */}
            {preflight.keys !== undefined && (
              <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-3">
                <p className="text-xs font-medium text-[var(--text-primary)] mb-1.5">
                  Чем спрашивали: {PLACE_LABELS[preflight.place ?? 'unknown'] ?? preflight.place}
                </p>
                <div className="space-y-1">
                  {preflight.keys.map(k => (
                    <p key={k.id} className="text-xs text-[var(--text-muted)] break-words">
                      {k.label} · {k.env}:{' '}
                      {k.identity.present ? (
                        <>
                          отпечаток <span className="font-mono text-[var(--text-secondary)]">{k.identity.fingerprint}</span>
                          {', '}{k.identity.format ?? 'формат не распознан'}, {k.identity.length} симв.
                        </>
                      ) : (
                        <span className="text-[var(--warning)]">не задан</span>
                      )}
                    </p>
                  ))}
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {preflight.providers.map(pr => (
                <div key={pr.id} className="flex items-start gap-2 p-2.5 rounded-lg bg-[var(--bg-primary)] border border-[var(--border)]">
                  <StatusDot ok={pr.available} />
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-[var(--text-primary)]">{pr.name}</p>
                    <p className="text-xs text-[var(--text-muted)] break-words">
                      {pr.available
                        ? `ответил за ${pr.latency_ms ?? 0} мс`
                        : pr.error ?? 'причина не названа'}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Сверка телефонов (issue #366) — рабочий экран для сверки с Артёмом */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
        <div className="flex items-center gap-2 mb-1">
          <PhoneCall className="w-4 h-4 text-[var(--text-muted)]" />
          <p className="text-sm font-semibold text-[var(--text-primary)]">Сверка официальных телефонов</p>
        </div>
        <p className="text-xs text-[var(--text-secondary)] mb-4">
          Номера из кода и портала visitkamchatka рядом. Ничего не меняется автоматически —
          правки в SOS-файлах только после подтверждения.
        </p>

        {phones.error && <p className="text-xs text-[var(--danger)]">Не удалось загрузить сверку</p>}
        {!phonesData && !phones.error && <div className="ds-skeleton h-24 rounded-lg" />}

        {phonesData && (
          <div className="space-y-5">
            <div className="flex flex-wrap gap-2">
              {Object.entries(phonesData.bySource).map(([source, count]) => (
                <span key={source} className="ds-badge border border-[var(--border)] text-[var(--text-secondary)]">
                  {SOURCE_LABELS[source] ?? source}: {count}
                </span>
              ))}
            </div>

            {phonesData.similarPairs.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-[var(--danger)] mb-2">
                  Похожие номера — вероятные опечатки ({phonesData.similarPairs.length})
                </p>
                <div className="space-y-2">
                  {phonesData.similarPairs.map((p, i) => (
                    <div key={i} className="p-3 rounded-lg bg-[var(--bg-primary)] border border-[var(--border)] text-xs">
                      <p className="text-[var(--text-primary)]">
                        <span className="font-medium">{p.codePhone}</span>
                        <span className="text-[var(--text-muted)]"> ({p.codeName ?? 'код'}) </span>
                        vs <span className="font-medium">{p.portalPhone}</span>
                        <span className="text-[var(--text-muted)]"> ({p.portalName ?? 'портал'})</span>
                      </p>
                      <p className="text-[var(--text-muted)] mt-0.5">Различие: {p.digitDiff} цифр(ы) в хвосте</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {phonesData.discrepancies.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-[var(--warning)] mb-2">
                  Разные номера в одном назначении ({phonesData.discrepancies.length})
                </p>
                <div className="space-y-2">
                  {phonesData.discrepancies.map((d, i) => (
                    <div key={i} className="p-3 rounded-lg bg-[var(--bg-primary)] border border-[var(--border)] text-xs">
                      <p className="font-medium text-[var(--text-primary)] mb-1">
                        {PURPOSE_LABELS[d.purpose] ?? d.purpose}
                      </p>
                      {d.phones.map((ph, j) => (
                        <p key={j} className="text-[var(--text-secondary)]">
                          {ph.phone} — {ph.name ?? 'без имени'}
                          <span className="text-[var(--text-muted)]"> · {SOURCE_LABELS[ph.source] ?? ph.source}</span>
                        </p>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {phonesData.similarPairs.length === 0 && phonesData.discrepancies.length === 0 && (
              <p className="text-xs text-[var(--success)]">Расхождений между источниками не найдено</p>
            )}

            <div>
              <p className="text-xs font-semibold text-[var(--text-primary)] mb-2">
                Где номера зашиты в коде ({phonesData.hardcodedSites.length})
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-[var(--text-muted)]">
                      <th className="py-1.5 pr-4 font-medium">Номер</th>
                      <th className="py-1.5 pr-4 font-medium">Роль</th>
                      <th className="py-1.5 pr-4 font-medium">Файлы</th>
                      <th className="py-1.5 font-medium">SOS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {phonesData.hardcodedSites.map((s, i) => (
                      <tr key={i} className="border-t border-[var(--border)]">
                        <td className="py-1.5 pr-4 text-[var(--text-primary)] whitespace-nowrap">{s.phone}</td>
                        <td className="py-1.5 pr-4 text-[var(--text-secondary)]">{s.role}</td>
                        <td className="py-1.5 pr-4 text-[var(--text-muted)]">{s.files.join(', ')}</td>
                        <td className="py-1.5">
                          {s.sosCritical
                            ? <span className="text-[var(--danger)]">критично</span>
                            : <span className="text-[var(--text-muted)]">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
