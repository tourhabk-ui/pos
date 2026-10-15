'use client';

import { useEffect, useRef, useState } from 'react';
import { MapPin, Search, X, Loader2 } from 'lucide-react';
import { locationTypeLabel } from '@/lib/places/location-types';

/**
 * Главное место тура — выбор из справочника мест (аудит 15.10, TOUR-PLACE).
 *
 * По этой связи тур попадает в «Туры к этому месту» на карточке места и в
 * китайские конспекты мест. Свободного текста здесь нет намеренно: связь
 * пишется адресом места, а не похожестью имени (§14 — «Авачинский» это и
 * вулкан, и перевал, и бухта). Поиск — общий публичный /api/places: только
 * видимые и не слитые места, те же, что примет роут правки тура.
 *
 * Поиск, который не ответил, говорит об этом словами (§4.0): «ничего не
 * нашлось» и «поиск не ответил» — разные состояния.
 */

export interface MainPlaceValue {
  id: string;
  name: string;
}

export type MainPlaceSource = 'coords_equal' | 'operator' | null;

interface PlaceHit {
  id: string;
  name: string;
  locationType: string | null;
}

type SearchState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'done'; hits: PlaceHit[] }
  | { kind: 'failed' };

interface Props {
  value: MainPlaceValue | null;
  /** Откуда сохранённая связь (main_place_source) — для подписи под выбранным. */
  savedSource: MainPlaceSource;
  /** Сохранённый id — подпись источника относится только к нему. */
  savedId: string | null;
  onChange: (next: MainPlaceValue | null) => void;
}

const MIN_QUERY = 2;

function isPlaceHit(x: unknown): x is PlaceHit {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return typeof r.id === 'string' && typeof r.name === 'string';
}

export function sourceNote(value: MainPlaceValue | null, savedId: string | null, savedSource: MainPlaceSource): string {
  if (!value) return 'Не выбрано. Тур не показывается на карточке места, пока место не выбрано или маршрут тура не размечен через него.';
  if (value.id !== savedId) return 'Новый выбор — сохранится вместе с туром.';
  if (savedSource === 'coords_equal') {
    return 'Связано автоматически: координаты тура совпали с координатами этого места. Проверьте и при необходимости выберите другое.';
  }
  if (savedSource === 'operator') return 'Выбрано в кабинете.';
  return 'Связь сохранена.';
}

export default function MainPlacePicker({ value, savedSource, savedId, onChange }: Props) {
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<SearchState>({ kind: 'idle' });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  function runSearch(q: string) {
    const my = ++seq.current;
    setSearch({ kind: 'loading' });
    fetch(`/api/places?q=${encodeURIComponent(q)}&limit=8`)
      .then(async (res) => {
        const json: unknown = await res.json().catch(() => null);
        const data = json && typeof json === 'object' ? (json as { success?: unknown; data?: unknown }) : null;
        if (!res.ok || !data || data.success !== true || !Array.isArray(data.data)) throw new Error(`HTTP ${res.status}`);
        if (my !== seq.current) return;
        setSearch({ kind: 'done', hits: data.data.filter(isPlaceHit) });
      })
      .catch((err: unknown) => {
        console.error('[MainPlacePicker] поиск мест не ответил:', err instanceof Error ? err.message : String(err));
        if (my !== seq.current) return;
        setSearch({ kind: 'failed' });
      });
  }

  function onQuery(next: string) {
    setQuery(next);
    if (timer.current) clearTimeout(timer.current);
    const q = next.trim();
    if (q.length < MIN_QUERY) {
      seq.current++;
      setSearch({ kind: 'idle' });
      return;
    }
    timer.current = setTimeout(() => runSearch(q), 280);
  }

  function pick(hit: PlaceHit) {
    onChange({ id: hit.id, name: hit.name });
    setQuery('');
    seq.current++;
    setSearch({ kind: 'idle' });
  }

  const inp = 'w-full pl-8 pr-3 py-2 text-sm bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] transition-colors';

  return (
    <div className="space-y-2" data-main-place-picker>
      <label className="block text-xs font-medium text-[var(--text-muted)]" htmlFor="main-place-search">
        <MapPin className="w-3 h-3 inline mr-1" />Главное место тура
      </label>

      {value ? (
        <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--bg-primary)]">
          <span className="text-sm text-[var(--text-primary)]" data-main-place-name>{value.name}</span>
          <button
            type="button"
            onClick={() => onChange(null)}
            className="flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--danger)] transition-colors"
          >
            <X className="w-3 h-3" />Снять
          </button>
        </div>
      ) : null}
      <p className="text-[11px] text-[var(--text-muted)]" data-main-place-note>{sourceNote(value, savedId, savedSource)}</p>

      <div className="relative">
        <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
        <input
          id="main-place-search"
          className={inp}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder={value ? 'Выбрать другое место из справочника' : 'Найти место в справочнике: вулкан, озеро, бухта'}
          autoComplete="off"
        />
      </div>

      {search.kind === 'loading' && (
        <p className="flex items-center gap-1 text-xs text-[var(--text-muted)]"><Loader2 className="w-3 h-3 animate-spin" />Ищем места…</p>
      )}
      {search.kind === 'failed' && (
        <p className="text-xs" style={{ color: 'var(--danger)' }} role="alert">Поиск мест не ответил — попробуйте ещё раз.</p>
      )}
      {search.kind === 'done' && search.hits.length === 0 && (
        <p className="text-xs text-[var(--text-muted)]">В справочнике мест такого не нашлось.</p>
      )}
      {search.kind === 'done' && search.hits.length > 0 && (
        <ul className="border border-[var(--border)] rounded-lg divide-y divide-[var(--border)] overflow-hidden" aria-label="Найденные места">
          {search.hits.map((h) => (
            <li key={h.id}>
              <button
                type="button"
                onClick={() => pick(h)}
                className="w-full text-left px-3 py-2 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
              >
                {h.name}
                <span className="ml-2 text-xs text-[var(--text-muted)]">{locationTypeLabel(h.locationType)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
