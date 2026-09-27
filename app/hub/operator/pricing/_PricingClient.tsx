'use client';

/**
 * Скидки оператора на свои туры.
 *
 * Владелец 27.09: «нужно чтоб всё работало, а не театр». Движок скидок был,
 * турист видит их на форме брони — а назначить скидку мог только
 * администратор. Здесь это делает тот, кто владеет туром.
 *
 * Экран НАРОЧНО узкий: два рода скидок, по одной на тур, и число процентов
 * рядом с ценой, чтобы видеть результат до сохранения. Общий редактор правил
 * (сезоны, надбавка за заполненность, раннее бронирование) остаётся у
 * администратора — там цена растёт, и такие решения не отдаются.
 */

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Percent, Trash2, Users, Clock, AlertCircle, Check } from 'lucide-react';
import {
  OPERATOR_RULE_TYPES, OPERATOR_RULE_LABEL, MAX_OPERATOR_DISCOUNT,
  discountToMultiplier, multiplierToDiscount, type OperatorRuleType,
} from '@/lib/tours/operator-discount';
import { bookingTotal } from '@/lib/tours/booking-total';
import { finalUnitPrice } from '@/lib/tours/pricing-rule-match';

interface Row {
  tour_id: string;
  title: string;
  base_price: string;
  price_unit: string | null;
  rule_id: string | null;
  rule_type: string | null;
  multiplier: string | null;
  days_before_max: number | null;
  guests_min: number | null;
}

interface TourRules {
  tourId: string;
  title: string;
  basePrice: number;
  priceUnit: string | null;
  rules: Partial<Record<OperatorRuleType, { id: string; percent: number | null; daysBefore: number | null; guestsMin: number | null }>>;
}

function formatPrice(p: number): string {
  return new Intl.NumberFormat('ru-RU').format(Math.round(p)) + ' ₽';
}

/** Строки одного тура — в один объект: на тур не больше одного правила рода. */
function groupRows(rows: Row[]): TourRules[] {
  const byTour = new Map<string, TourRules>();
  for (const r of rows) {
    let t = byTour.get(r.tour_id);
    if (!t) {
      t = {
        tourId: r.tour_id,
        title: r.title,
        basePrice: parseFloat(r.base_price) || 0,
        priceUnit: r.price_unit,
        rules: {},
      };
      byTour.set(r.tour_id, t);
    }
    if (r.rule_id && r.rule_type && (OPERATOR_RULE_TYPES as readonly string[]).includes(r.rule_type)) {
      t.rules[r.rule_type as OperatorRuleType] = {
        id: r.rule_id,
        percent: r.multiplier !== null ? multiplierToDiscount(r.multiplier) : null,
        daysBefore: r.days_before_max,
        guestsMin: r.guests_min,
      };
    }
  }
  return [...byTour.values()];
}

export default function PricingClient() {
  const [tours, setTours] = useState<TourRules[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  /** Черновики полей: ключ «тур:род». Пустой — берём то, что уже назначено. */
  const [draft, setDraft] = useState<Record<string, { percent: string; cond: string }>>({});

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch('/api/hub/operator/pricing-rules');
      const d = await r.json() as { success?: boolean; data?: Row[]; error?: string };
      if (!r.ok || d.success !== true || !Array.isArray(d.data)) {
        throw new Error(d.error ?? `не загрузилось (HTTP ${r.status})`);
      }
      setTours(groupRows(d.data));
    } catch (e) {
      setTours([]);
      setError(e instanceof Error ? e.message : 'Не удалось прочитать скидки');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function draftOf(tourId: string, type: OperatorRuleType, current: TourRules['rules'][OperatorRuleType]) {
    const key = `${tourId}:${type}`;
    const d = draft[key];
    if (d) return d;
    return {
      percent: current?.percent != null ? String(current.percent) : '',
      cond: type === 'last_minute'
        ? (current?.daysBefore != null ? String(current.daysBefore) : '7')
        : (current?.guestsMin != null ? String(current.guestsMin) : '4'),
    };
  }

  function setDraftField(tourId: string, type: OperatorRuleType, field: 'percent' | 'cond', value: string, current: TourRules['rules'][OperatorRuleType]) {
    const key = `${tourId}:${type}`;
    const base = draftOf(tourId, type, current);
    setDraft((prev) => ({ ...prev, [key]: { ...base, [field]: value } }));
    setSaved(null);
    setError(null);
  }

  async function save(tourId: string, type: OperatorRuleType, current: TourRules['rules'][OperatorRuleType]) {
    const d = draftOf(tourId, type, current);
    const percent = parseInt(d.percent, 10);
    const cond = parseInt(d.cond, 10);
    if (!Number.isFinite(percent) || percent < 1 || percent > MAX_OPERATOR_DISCOUNT) {
      setError(`Скидка — от 1 до ${MAX_OPERATOR_DISCOUNT} процентов`);
      return;
    }
    if (!Number.isFinite(cond) || cond < (type === 'last_minute' ? 1 : 2)) {
      setError(type === 'last_minute' ? 'Укажите, за сколько дней до выезда' : 'Укажите, от какого числа человек');
      return;
    }
    setBusy(`${tourId}:${type}`);
    setError(null);
    try {
      const r = await fetch('/api/hub/operator/pricing-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tourId: Number(tourId),
          ruleType: type,
          percent,
          ...(type === 'last_minute' ? { daysBefore: cond } : { guestsMin: cond }),
        }),
      });
      const data = await r.json() as { success?: boolean; error?: string };
      if (!r.ok || data.success !== true) throw new Error(data.error ?? `не сохранилось (HTTP ${r.status})`);
      setDraft((prev) => { const n = { ...prev }; delete n[`${tourId}:${type}`]; return n; });
      setSaved(`${tourId}:${type}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось сохранить скидку');
    } finally {
      setBusy(null);
    }
  }

  async function remove(tourId: string, type: OperatorRuleType, ruleId: string) {
    setBusy(`${tourId}:${type}`);
    setError(null);
    try {
      const r = await fetch(`/api/hub/operator/pricing-rules?id=${encodeURIComponent(ruleId)}`, { method: 'DELETE' });
      const data = await r.json() as { success?: boolean; error?: string };
      if (!r.ok || data.success !== true) throw new Error(data.error ?? `не снялось (HTTP ${r.status})`);
      setDraft((prev) => { const n = { ...prev }; delete n[`${tourId}:${type}`]; return n; });
      setSaved(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось снять скидку');
    } finally {
      setBusy(null);
    }
  }

  if (tours === null) {
    return (
      <div className="ds-page">
        <p className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
          <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" />Читаем ваши туры…
        </p>
      </div>
    );
  }

  return (
    <div className="ds-page space-y-6">
      <div>
        <h1 className="ds-h1">Скидки</h1>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          Турист видит цену со скидкой сразу, как выберет дату, — и ровно эту сумму получит в заявке.
        </p>
      </div>

      {error && (
        <p role="alert" className="ds-card flex items-start gap-2 p-4 text-sm text-[var(--text-primary)]">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warning)]" />
          {error}
        </p>
      )}

      {tours.length === 0 && !error && (
        <p className="ds-card p-4 text-sm text-[var(--text-secondary)]">
          Активных туров нет — скидку назначать не на что.
        </p>
      )}

      {tours.map((t) => (
        <section key={t.tourId} className="ds-card p-5 space-y-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="ds-h2 text-lg">{t.title}</h2>
            <span className="text-sm text-[var(--text-secondary)]">
              без скидки {formatPrice(t.basePrice)}
            </span>
          </div>

          {OPERATOR_RULE_TYPES.map((type) => {
            const current = t.rules[type];
            const d = draftOf(t.tourId, type, current);
            const key = `${t.tourId}:${type}`;
            const percent = parseInt(d.percent, 10);
            /**
             * Цена «как увидит турист» — тем же правилом, что считает сервер и
             * бронь (`discountToMultiplier` + `bookingTotal`). Своя арифметика
             * здесь показала бы одну цифру, а счёт выставил другую.
             */
            const preview = Number.isFinite(percent) && percent >= 1 && percent <= MAX_OPERATOR_DISCOUNT
              ? bookingTotal({
                // Те же две функции, что считают цену на сервере и в брони:
                // округление до сотни и единица цены. Своя арифметика здесь
                // показала бы оператору одну цифру, а счёт выставил другую.
                basePrice: finalUnitPrice(t.basePrice, discountToMultiplier(percent)),
                priceUnit: t.priceUnit,
                participants: type === 'group_discount' ? Math.max(2, parseInt(d.cond, 10) || 2) : 1,
              })
              : null;

            return (
              <div key={type} className="border-t border-[var(--border)] pt-4 space-y-3">
                <div>
                  <p className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
                    {type === 'last_minute'
                      ? <Clock className="h-4 w-4 text-[var(--ocean)]" />
                      : <Users className="h-4 w-4 text-[var(--ocean)]" />}
                    {OPERATOR_RULE_LABEL[type].title}
                  </p>
                  <p className="mt-0.5 text-xs leading-snug text-[var(--text-secondary)]">
                    {OPERATOR_RULE_LABEL[type].hint}
                  </p>
                </div>

                <div className="flex flex-wrap items-end gap-3">
                  <label className="flex flex-col gap-1">
                    <span className="ds-label">Скидка, %</span>
                    <input
                      type="number" min={1} max={MAX_OPERATOR_DISCOUNT} inputMode="numeric"
                      aria-label={`${OPERATOR_RULE_LABEL[type].title}: процент`}
                      value={d.percent}
                      onChange={(e) => setDraftField(t.tourId, type, 'percent', e.target.value, current)}
                      className="ds-input w-24 text-sm"
                      placeholder="15"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="ds-label">
                      {type === 'last_minute' ? 'За сколько дней' : 'От сколько человек'}
                    </span>
                    <input
                      type="number" min={type === 'last_minute' ? 1 : 2} inputMode="numeric"
                      aria-label={type === 'last_minute' ? 'За сколько дней до выезда' : 'От какого числа человек'}
                      value={d.cond}
                      onChange={(e) => setDraftField(t.tourId, type, 'cond', e.target.value, current)}
                      className="ds-input w-28 text-sm"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => void save(t.tourId, type, current)}
                    disabled={busy === key}
                    className="ds-btn ds-btn-primary text-sm disabled:opacity-50"
                    style={{ minHeight: 44 }}
                  >
                    {busy === key
                      ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                      : <Percent className="h-4 w-4" />}
                    {current ? 'Изменить' : 'Назначить'}
                  </button>
                  {current && (
                    <button
                      type="button"
                      onClick={() => void remove(t.tourId, type, current.id)}
                      disabled={busy === key}
                      className="ds-btn ds-btn-secondary text-sm disabled:opacity-50"
                      style={{ minHeight: 44 }}
                    >
                      <Trash2 className="h-4 w-4" />Снять
                    </button>
                  )}
                </div>

                <p className="min-h-[1.25rem] text-sm" aria-live="polite">
                  {preview !== null ? (
                    <span className="text-[var(--text-secondary)]">
                      Турист увидит{' '}
                      <span className="font-semibold text-[var(--text-primary)]">{formatPrice(preview)}</span>
                      {' '}вместо {formatPrice(t.basePrice)}
                      {type === 'group_discount' ? ` при ${Math.max(2, parseInt(d.cond, 10) || 2)} чел.` : ''}
                    </span>
                  ) : current ? (
                    <span className="text-[var(--text-secondary)]">
                      Назначено: −{current.percent}%{' '}
                      {type === 'last_minute'
                        ? `за ${current.daysBefore} дн. до выезда`
                        : `от ${current.guestsMin} чел.`}
                    </span>
                  ) : (
                    <span className="text-[var(--text-muted)]">Скидка не назначена</span>
                  )}
                  {saved === key && (
                    <span className="ml-2 inline-flex items-center gap-1 text-[var(--success)]">
                      <Check className="h-4 w-4" />сохранено
                    </span>
                  )}
                </p>
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}
