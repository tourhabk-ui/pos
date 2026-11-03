'use client';

/**
 * Наценка на выходные (сб, вс) — K.ai B1. Решение владельца 03.11:
 * наценка оператору до 30%, выходные — суббота и воскресенье.
 * Цена с наценкой показана рядом без округления — как просил владелец;
 * итоговую цену туристу считает тот же движок, что и счёт.
 */
import { useCallback, useEffect, useState } from 'react';

interface Row { tourId: number; title: string; basePrice: number; priceUnit: string; percent: number | null }
const MAX = 30;
const rub = (n: number) => `${n.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;

export default function WeekendMarkup() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [draft, setDraft] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch('/api/hub/operator/weekend-markup', { cache: 'no-store' });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j?.success) { setError(j?.error ?? 'Не удалось прочитать наценки'); return; }
    setRows(j.data);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function save(tourId: number, percent: number | null) {
    setError(null);
    const r = percent === null
      ? await fetch(`/api/hub/operator/weekend-markup?tourId=${tourId}`, { method: 'DELETE' })
      : await fetch('/api/hub/operator/weekend-markup', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tourId, percent }),
        });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j?.success) { setError(j?.error ?? 'Не удалось сохранить'); return; }
    await load();
  }

  if (!rows) return error ? <p className="text-sm text-[var(--danger)]">{error}</p> : null;
  return (
    <section className="ds-card p-5 space-y-3" data-testid="weekend-markup">
      <h2 className="text-lg font-semibold">Наценка на выходные (сб, вс)</h2>
      <p className="text-sm text-[var(--text-muted)]">От 1 до {MAX}%. Действует на даты поездки в субботу и воскресенье; уже оформленные брони не меняются.</p>
      {error && <p className="text-sm text-[var(--danger)]">{error}</p>}
      {rows.map((t) => {
        const p = Number(draft[t.tourId] ?? t.percent ?? '');
        const valid = Number.isInteger(p) && p >= 1 && p <= MAX;
        return (
          <div key={t.tourId} className="flex flex-wrap items-center gap-3">
            <span className="min-w-[12rem]">{t.title}</span>
            <input type="number" min={1} max={MAX} className="ds-input w-20" aria-label={`Наценка для ${t.title}`}
              value={draft[t.tourId] ?? (t.percent ?? '')}
              onChange={(e) => setDraft({ ...draft, [t.tourId]: e.target.value })} />
            <span className="text-sm">%{valid ? ` → ${rub(t.basePrice * (100 + p) / 100)} вместо ${rub(t.basePrice)}` : ''}</span>
            <button className="ds-btn" disabled={!valid} onClick={() => save(t.tourId, p)}>Сохранить</button>
            {t.percent !== null && <button className="ds-btn-ghost" onClick={() => save(t.tourId, null)}>Снять</button>}
          </div>
        );
      })}
    </section>
  );
}
