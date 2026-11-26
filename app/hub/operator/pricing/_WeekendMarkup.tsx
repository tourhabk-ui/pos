'use client';

/**
 * Наценка на выходные (сб, вс) — K.ai B1. Решение владельца 03.11:
 * наценка оператору до 30%, выходные — суббота и воскресенье.
 * Цена с наценкой показана рядом без округления — как просил владелец;
 * итоговую цену туристу считает тот же движок, что и счёт.
 *
 * С 23.11 наценка выходит на сайт после проверки администратором (слово
 * владельца: «Наценки тоже показываются в модерации: цена тура меняется
 * только через одну дверь»). Экран поэтому показывает раздельно, что
 * действует и о чём владелец попросил, и не говорит «сохранено» там, где
 * цена на сайте ещё прежняя.
 */
import { useCallback, useEffect, useState } from 'react';
import { PricingRuleStatus } from '@/components/operator/PricingRuleStatus';

interface Row {
  tourId: number;
  title: string;
  basePrice: number;
  priceUnit: string;
  /** Наценка, которая действует на сайте. */
  percent: number | null;
  ruleId: string | null;
  removalAsked: boolean;
  /** В снятии действующей наценки отказано: причина администратора. */
  removalRefused?: string | null;
  request: { ruleId: string; percent: number | null; status: 'pending' | 'rejected'; reason: string | null } | null;
}
const MAX = 30;
const rub = (n: number) => `${n.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;

/** Наценка словами владельца. Процент не прочитан — так и сказано. */
export function markupWords(percent: number | null): string {
  return percent === null ? 'процент не прочитан' : `+${percent}% в субботу и воскресенье`;
}

export default function WeekendMarkup() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [draft, setDraft] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [said, setSaid] = useState<{ tourId: number; words: string } | null>(null);

  const load = useCallback(async () => {
    const r = await fetch('/api/hub/operator/weekend-markup', { cache: 'no-store' });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j?.success) { setError(j?.error ?? 'Не удалось прочитать наценки'); return; }
    setRows(j.data);
  }, []);
  useEffect(() => { void load(); }, [load]);

  /** Одна просьба: что произошло, говорит сервер — «на проверку», «уже действует», «убрана». */
  async function send(tourId: number, request: () => Promise<Response>, fallback: string) {
    setError(null);
    setSaid(null);
    setBusy(tourId);
    try {
      const r = await request();
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.success) { setError(j?.error ?? fallback); return; }
      setDraft((prev) => { const next = { ...prev }; delete next[tourId]; return next; });
      setSaid({ tourId, words: typeof j.message === 'string' ? j.message : 'Готово' });
      await load();
    } catch {
      setError(`${fallback}: нет связи`);
    } finally {
      setBusy(null);
    }
  }

  const ask = (tourId: number, percent: number) => send(
    tourId,
    () => fetch('/api/hub/operator/weekend-markup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tourId, percent }),
    }),
    'Не удалось отправить наценку',
  );
  /** Убрать одно правило: неодобренное — сразу, действующее — просьбой администратору. */
  const remove = (tourId: number, ruleId: string) => send(
    tourId,
    () => fetch(`/api/hub/operator/weekend-markup?ruleId=${encodeURIComponent(ruleId)}`, { method: 'DELETE' }),
    'Не удалось убрать наценку',
  );

  if (!rows) return error ? <p className="text-sm text-[var(--danger)]" role="alert">{error}</p> : null;
  return (
    <section className="ds-card p-5 space-y-4" data-testid="weekend-markup">
      <h2 className="text-lg font-semibold">Наценка на выходные (сб, вс)</h2>
      <p className="text-sm text-[var(--text-muted)]">
        От 1 до {MAX}%. Действует на даты поездки в субботу и воскресенье; уже оформленные брони не меняются.
        Наценка начинает действовать после проверки администратором.
      </p>
      {error && <p className="text-sm text-[var(--danger)]" role="alert">{error}</p>}
      {rows.map((t) => {
        // В поле — то, о чём владелец просил последним; нет просьбы — то, что действует.
        const shown = draft[t.tourId] ?? String(t.request?.percent ?? t.percent ?? '');
        const p = Number(shown);
        const valid = shown !== '' && Number.isInteger(p) && p >= 1 && p <= MAX;
        return (
          <div key={t.tourId} className="space-y-2" data-testid="weekend-markup-row">
            <div className="flex flex-wrap items-center gap-3">
              <span className="min-w-[12rem] text-[var(--text-primary)]">{t.title}</span>
              <input type="number" min={1} max={MAX} className="ds-input w-20" aria-label={`Наценка для ${t.title}`}
                value={shown}
                onChange={(e) => setDraft({ ...draft, [t.tourId]: e.target.value })} />
              <span className="text-sm text-[var(--text-secondary)]">
                %{valid ? ` → с такой наценкой ${rub(t.basePrice * (100 + p) / 100)} вместо ${rub(t.basePrice)}` : ''}
              </span>
              <button type="button" className="ds-btn ds-btn-primary text-sm disabled:opacity-50" style={{ minHeight: 44 }}
                disabled={!valid || busy === t.tourId} onClick={() => void ask(t.tourId, p)}>
                Отправить на проверку
              </button>
              {t.ruleId !== null && t.percent !== null && !t.removalAsked && (
                <button type="button" className="ds-btn ds-btn-secondary text-sm disabled:opacity-50" style={{ minHeight: 44 }}
                  disabled={busy === t.tourId} onClick={() => void remove(t.tourId, t.ruleId!)}>
                  Попросить снять
                </button>
              )}
            </div>
            {said?.tourId === t.tourId && (
              <p className="text-sm text-[var(--text-primary)]" data-testid="markup-said" aria-live="polite">{said.words}</p>
            )}
            <PricingRuleStatus
              noun="наценка"
              live={t.ruleId !== null ? markupWords(t.percent) : null}
              removalAsked={t.removalAsked}
              removalRefused={t.removalRefused ?? null}
              request={t.request
                ? { words: markupWords(t.request.percent), status: t.request.status, reason: t.request.reason }
                : null}
              busy={busy === t.tourId}
              onWithdraw={() => { if (t.request) void remove(t.tourId, t.request.ruleId); }}
            />
          </div>
        );
      })}
    </section>
  );
}
