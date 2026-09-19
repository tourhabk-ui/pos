'use client';

/**
 * Панель спутникового трекера на карточке активной регистрации.
 *
 * Решение владельца 19.09 («делай пок 3»): точка с трекера должна доходить
 * до маршрута, когда телефон молчит. Приёмник — `POST /api/safety/tracker/
 * [token]`, а здесь человек заводит токен и видит, работает ли он.
 *
 * ── Почему панель показывает счётчики, а не только кнопку ────────────────
 *
 * Ответ приёмника человек не видит НИКОГДА: запрос делает устройство за
 * сотни километров. Без счётчиков «трекер подключён» и «трекер шлёт мусор»
 * выглядели бы одинаково — молчанием. Поэтому связка называет своё
 * состояние словами: сколько точек пришло, когда последняя, и что именно не
 * понравилось приёмнику в последний раз.
 *
 * ── Почему файл лежит в components/hub, а не в components/safety ─────────
 *
 * Панель монтируется ТОЛЬКО на странице за входом (`/hub/tourist/safety`) и
 * зовёт личные API под `requireAuth`. Каталог `components/` сам не знает, где
 * его используют, поэтому принадлежность фиксируется именем каталога —
 * сторож `public-fetch-edge` читает именно его. В `components/safety` лежит
 * то, что открыто анониму по построению (QR-эстафета SOS), и класть туда
 * личную панель значило бы объявить её публичной.
 *
 * ── Адрес показывается один раз ──────────────────────────────────────────
 *
 * Полный адрес с токеном приходит только в ответе на создание. Дальше его
 * нет ни в списке, ни где-либо ещё: этот экран открывают в кафе и в
 * автобусе, и секрет, лежащий на виду, перестаёт быть секретом. Потерял —
 * отзови и создай новую: это одно нажатие.
 */

import { useCallback, useEffect, useState } from 'react';
import { Satellite, Copy, Check, AlertTriangle, Loader2 } from 'lucide-react';

interface TrackerLink {
  id: string;
  label: string | null;
  vendor: string | null;
  created_at: string;
  revoked_at: string | null;
  points_total: number;
  last_point_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  silent: boolean;
}

function ago(iso: string): string {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (min < 60) return `${min} мин назад`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} ч назад`;
  return `${Math.round(h / 24)} дн назад`;
}

export function TrackerLinkPanel({ registrationId }: { registrationId: string }) {
  const [links, setLinks] = useState<TrackerLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [freshUrl, setFreshUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [label, setLabel] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/safety/tracker-links?registrationId=${encodeURIComponent(registrationId)}`);
      const d = await res.json() as { ok?: boolean; links?: TrackerLink[]; error?: string };
      if (!res.ok || !d.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      setLinks(d.links ?? []);
    } catch (err) {
      // «Список пуст» и «не смогли прочитать» — разные состояния (§4.0).
      setError(err instanceof Error ? err.message : 'Не удалось прочитать связки');
      setLinks([]);
    } finally {
      setLoading(false);
    }
  }, [registrationId]);

  useEffect(() => { void load(); }, [load]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/safety/tracker-links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ registrationId, label: label.trim() || undefined }),
      });
      const d = await res.json() as { ok?: boolean; url?: string; error?: string };
      if (!res.ok || !d.ok || !d.url) throw new Error(d.error ?? `HTTP ${res.status}`);
      setFreshUrl(d.url);
      setLabel('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось создать связку');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/safety/tracker-links?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      const d = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !d.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось отозвать');
    } finally {
      setBusy(false);
    }
  }

  const live = links.filter((l) => !l.revoked_at);

  return (
    <div className="mt-4 border-t border-[var(--border)] pt-4">
      <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
        <Satellite className="h-3.5 w-3.5" aria-hidden /> Спутниковый трекер
      </p>

      {loading && (
        <p className="mt-2 flex items-center gap-2 text-sm text-[var(--text-secondary)]">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Читаем…
        </p>
      )}

      {error && (
        <p className="mt-2 flex items-start gap-2 text-sm text-[var(--danger)]">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {error}
        </p>
      )}

      {!loading && live.length === 0 && !freshUrl && (
        <>
          <p className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">
            Если несёте спутниковый трекер — подключите его, и ваша точка будет доходить
            до спасателей даже там, где телефон молчит.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Как называется устройство"
              className="ds-input min-w-[200px] flex-1"
            />
            <button onClick={create} disabled={busy} className="ds-btn ds-btn-primary text-sm disabled:opacity-50">
              {busy ? 'Создаём…' : 'Подключить'}
            </button>
          </div>
        </>
      )}

      {freshUrl && (
        <div className="mt-3 rounded-lg bg-[var(--bg-hover)] p-4">
          <p className="text-sm font-semibold text-[var(--text-primary)]">
            Адрес для настроек трекера
          </p>
          <p className="mt-1 text-xs leading-relaxed text-[var(--text-secondary)]">
            Вбейте его в отправку вашего устройства или шлюза (HTTP POST, тело
            <code className="mx-1 rounded bg-[var(--bg-card)] px-1 py-0.5">{'{"lat": 53.01, "lng": 158.65}'}</code>).
            Показывается один раз — потеряете, отзовите связку и создайте новую.
          </p>
          <div className="mt-2 flex items-start gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-[var(--bg-card)] p-2 text-xs text-[var(--text-primary)]">
              {freshUrl}
            </code>
            <button
              onClick={() => {
                void navigator.clipboard?.writeText(freshUrl).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                });
              }}
              className="ds-btn ds-btn-secondary shrink-0 text-sm"
              aria-label="Скопировать адрес"
            >
              {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
            </button>
          </div>
        </div>
      )}

      {live.length > 0 && (
        <ul className="mt-3 space-y-2">
          {live.map((l) => (
            <li key={l.id} className="rounded-lg bg-[var(--bg-hover)] p-3 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium text-[var(--text-primary)]">
                  {l.label || 'Трекер без названия'}
                </span>
                <button
                  onClick={() => revoke(l.id)}
                  disabled={busy}
                  className="text-xs text-[var(--text-muted)] underline disabled:opacity-50"
                >
                  отозвать
                </button>
              </div>

              {/* Состояние связки словами. Ноль точек и «точки были, потом
                  кончились» — разные беды, и лечатся они по-разному. */}
              <p className="mt-1 text-[var(--text-secondary)]">
                {l.silent
                  ? 'Ни одной точки не приходило — проверьте адрес в настройках устройства.'
                  : `Точек принято: ${l.points_total}${l.last_point_at ? ` · последняя ${ago(l.last_point_at)}` : ''}`}
              </p>

              {l.last_error && (
                <p className="mt-1 text-xs text-[var(--warning)]">
                  Последний отказ{l.last_error_at ? ` (${ago(l.last_error_at)})` : ''}: {l.last_error}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
