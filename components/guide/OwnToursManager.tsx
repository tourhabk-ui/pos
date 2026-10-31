'use client';

/**
 * «Мои туры» в разделе «Свои туры» кабинета гида (слово владельца 31.10: гид
 * сам создаёт свои туры). Новый тур — форма из четырёх обязательных полей
 * (название, цена, группа, описание) → черновик (`POST /api/guide/own/tours`,
 * общая функция сайта и чата). У каждого тура — на сайте он или черновик,
 * чего не хватает до сайта (тот же гейт, что у кнопки), «Опубликовать» /
 * «Снять с сайта» (`POST …/publish`) и «Править» — те же поля формой
 * (`PATCH /api/guide/own/tours/[id]`, общая запись тура `writeTourPatch`).
 *
 * Программу, что включено, что взять и правила безопасности форма не правит:
 * их гид пишет фразой в чате кабинета или документом Word в MAX — так и
 * сказано под формой. Форма оператора (components/operator/Tours/TourForm)
 * сюда не взята: она требует вид места, активность и маршрут, загружает фото
 * в хранилище оператора и шлёт в его кабинет, куда гида не пускают.
 */

import { useState } from 'react';
import Link from 'next/link';
import { Loader2, Plus, Globe, EyeOff, Pencil } from 'lucide-react';
import type { OwnTour } from '@/lib/guides/own-tours';
import { ownTourStateWords, publishBlockerLabel } from '@/lib/guides/own-tour-words';
import { PRICE_UNIT_LABELS } from '@/lib/tours/labels';

interface FormValues {
  title: string;
  base_price: string;
  price_unit: 'per_person' | 'per_tour';
  max_participants: string;
  short_description: string;
  description: string;
}

const EMPTY: FormValues = { title: '', base_price: '', price_unit: 'per_person', max_participants: '', short_description: '', description: '' };

function valuesOf(t: OwnTour): FormValues {
  return {
    title: t.title,
    base_price: t.base_price === null ? '' : String(Math.round(Number(t.base_price))),
    price_unit: t.price_unit === 'per_tour' ? 'per_tour' : 'per_person',
    max_participants: t.max_participants === null ? '' : String(t.max_participants),
    short_description: t.short_description ?? '',
    description: t.description ?? '',
  };
}

/** Чего не хватает форме, чтобы отправить: словами, а не молчащей кнопкой. */
export function formGaps(v: FormValues): string[] {
  const gaps: string[] = [];
  if (v.title.trim().length < 5) gaps.push('название — хотя бы 5 знаков');
  const price = Number(v.base_price);
  if (!Number.isInteger(price) || price < 100) gaps.push('цена — целым числом рублей, от 100');
  const group = Number(v.max_participants);
  if (!Number.isInteger(group) || group < 1) gaps.push('размер группы — сколько человек максимум');
  if (v.description.trim().length === 0) gaps.push('описание');
  return gaps;
}

async function send(url: string, method: 'POST' | 'PATCH', body: unknown): Promise<{ ok: boolean; json: Record<string, unknown> | null }> {
  try {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => null) as Record<string, unknown> | null;
    return { ok: res.ok && json?.success === true, json };
  } catch {
    return { ok: false, json: { error: 'Сеть недоступна — ничего не записано' } };
  }
}

export function OwnTourForm({ tour, onDone, onCancel }: {
  /** Нет — новый тур; есть — правка этого тура. */
  tour?: OwnTour;
  onDone: (msg: string) => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState<FormValues>(tour ? valuesOf(tour) : EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gaps = formGaps(v);
  const set = (k: keyof FormValues) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setV((prev) => ({ ...prev, [k]: e.target.value }));

  const submit = async () => {
    if (gaps.length > 0) return;
    setBusy(true);
    setError(null);
    const body: Record<string, unknown> = {
      title: v.title.trim(),
      base_price: Number(v.base_price),
      price_unit: v.price_unit,
      max_participants: Number(v.max_participants),
      description: v.description.trim(),
    };
    if (tour) body.short_description = v.short_description.trim() || null;
    else if (v.short_description.trim()) body.short_description = v.short_description.trim();
    const r = tour
      ? await send(`/api/guide/own/tours/${tour.id}`, 'PATCH', body)
      : await send('/api/guide/own/tours', 'POST', body);
    setBusy(false);
    if (!r.ok) {
      setError(typeof r.json?.error === 'string' ? r.json.error : 'Не записано — попробуйте ещё раз');
      return;
    }
    onDone(tour ? `«${v.title.trim()}»: сохранено.` : `Создан черновик «${v.title.trim()}». Туристы его пока не видят — опубликуйте, когда будете готовы.`);
  };

  const id = tour ? `own-tour-${tour.id}` : 'own-tour-new';
  return (
    <form className="ds-card space-y-3" aria-label={tour ? `Правка тура «${tour.title}»` : 'Новый тур'}
      onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <label className="block text-sm" htmlFor={`${id}-title`}>
        <span className="text-[var(--text-secondary)]">Название</span>
        <input id={`${id}-title`} className="ds-input mt-1 w-full" value={v.title} onChange={set('title')} maxLength={255} />
      </label>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block text-sm" htmlFor={`${id}-price`}>
          <span className="text-[var(--text-secondary)]">Цена, ₽</span>
          <input id={`${id}-price`} type="number" inputMode="numeric" min={100} className="ds-input mt-1 w-full" value={v.base_price} onChange={set('base_price')} />
        </label>
        <label className="block text-sm" htmlFor={`${id}-unit`}>
          <span className="text-[var(--text-secondary)]">Цена</span>
          <select id={`${id}-unit`} className="ds-input mt-1 w-full" value={v.price_unit} onChange={set('price_unit')}>
            <option value="per_person">{PRICE_UNIT_LABELS.per_person}</option>
            <option value="per_tour">{PRICE_UNIT_LABELS.per_tour}</option>
          </select>
        </label>
        <label className="block text-sm" htmlFor={`${id}-group`}>
          <span className="text-[var(--text-secondary)]">Группа, человек максимум</span>
          <input id={`${id}-group`} type="number" inputMode="numeric" min={1} className="ds-input mt-1 w-full" value={v.max_participants} onChange={set('max_participants')} />
        </label>
      </div>
      <label className="block text-sm" htmlFor={`${id}-short`}>
        <span className="text-[var(--text-secondary)]">Анонс — строка под названием (можно пусто)</span>
        <input id={`${id}-short`} className="ds-input mt-1 w-full" value={v.short_description} onChange={set('short_description')} maxLength={500} />
      </label>
      <label className="block text-sm" htmlFor={`${id}-desc`}>
        <span className="text-[var(--text-secondary)]">Описание — что за поездка; программу дня пишите отдельно</span>
        <textarea id={`${id}-desc`} className="ds-input mt-1 w-full min-h-32" value={v.description} onChange={set('description')} maxLength={4000} />
      </label>
      <p className="text-sm text-[var(--text-muted)]">
        Программу, что включено, что взять и правила безопасности пишите фразой в чате кабинета («Горелый: программа: …») или документом Word в MAX.
      </p>
      {gaps.length > 0 && (
        <p className="text-sm text-[var(--text-secondary)]" data-testid="own-tour-gaps">Чтобы сохранить, не хватает: {gaps.join(', ')}.</p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="ds-btn ds-btn-primary" disabled={busy || gaps.length > 0} aria-disabled={busy || gaps.length > 0}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : null} {tour ? 'Сохранить' : 'Создать черновик'}
        </button>
        <button type="button" className="ds-btn ds-btn-secondary" disabled={busy} onClick={onCancel}>Отмена</button>
      </div>
      {!tour && <p className="text-sm text-[var(--text-muted)]">Черновик туристы не видят. На сайт — кнопкой «Опубликовать» у тура.</p>}
      {error && <p role="alert" className="text-sm text-[var(--danger)]">{error}</p>}
    </form>
  );
}

function priceText(t: OwnTour): string {
  if (t.base_price === null) return 'цена не записана';
  const n = Math.round(Number(t.base_price)).toLocaleString('ru-RU');
  return `${n} ₽ ${PRICE_UNIT_LABELS[t.price_unit ?? ''] ?? ''}`.trim();
}

export function OwnTourCard({ tour, onDone }: { tour: OwnTour; onDone: (msg: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Ответ шлюза каталога из того же запроса; старый ответ без него — по флагам.
  const onSite = tour.on_storefront ?? (tour.is_published && tour.is_active);
  const blockers = tour.blockers ?? [];

  const toggle = async (publish: boolean) => {
    setBusy(true);
    setError(null);
    const r = await send(`/api/guide/own/tours/${tour.id}/publish`, 'POST', { publish });
    setBusy(false);
    if (!r.ok) {
      setError(typeof r.json?.error === 'string' ? r.json.error : 'Не записано — попробуйте ещё раз');
      return;
    }
    onDone(typeof r.json?.message === 'string' ? r.json.message : publish ? 'Опубликовано' : 'Снято с сайта');
  };

  if (editing) {
    return <OwnTourForm tour={tour} onDone={(m) => { setEditing(false); onDone(m); }} onCancel={() => setEditing(false)} />;
  }
  return (
    <li className="ds-card space-y-2" data-testid={`own-tour-${tour.id}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        {onSite
          ? <Link href={`/catalog/tours/${tour.id}`} className="font-medium text-[var(--ocean)]">{tour.title}</Link>
          : <span className="font-medium text-[var(--text-primary)]">{tour.title}</span>}
        <span className="text-sm text-[var(--text-secondary)]">{ownTourStateWords(onSite)}</span>
      </div>
      <p className="text-sm text-[var(--text-secondary)]">
        {priceText(tour)} · группа {tour.max_participants === null ? 'не записана' : `до ${tour.max_participants} чел.`}
        {onSite ? ` · открытых дат: ${tour.open_dates}` : ''}
      </p>
      {!onSite && blockers.length > 0 && (
        <div className="text-sm">
          <p className="text-[var(--text-primary)]">Чего не хватает до сайта:</p>
          <ul className="list-disc pl-5 text-[var(--text-secondary)]">
            {blockers.map((b) => <li key={b}>{publishBlockerLabel(b)}</li>)}
          </ul>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {onSite ? (
          <button type="button" className="ds-btn ds-btn-secondary" disabled={busy} onClick={() => void toggle(false)}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <EyeOff size={14} />} Снять с сайта
          </button>
        ) : blockers.length === 0 && (
          <button type="button" className="ds-btn ds-btn-primary" disabled={busy} onClick={() => void toggle(true)}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Globe size={14} />} Опубликовать
          </button>
        )}
        <button type="button" className="ds-btn ds-btn-secondary" disabled={busy} onClick={() => setEditing(true)}>
          <Pencil size={14} /> Править
        </button>
      </div>
      {error && <p role="alert" className="text-sm text-[var(--danger)]">{error}</p>}
    </li>
  );
}

export function OwnToursManager({ tours, onDone }: { tours: OwnTour[]; onDone: (msg: string) => void }) {
  const [creating, setCreating] = useState(false);
  return (
    <div className="space-y-3">
      {tours.length === 0 && !creating && (
        <p className="text-sm text-[var(--text-secondary)]">Своих туров пока нет — создайте первый.</p>
      )}
      {tours.length > 0 && <ul className="space-y-3">{tours.map((t) => <OwnTourCard key={t.id} tour={t} onDone={onDone} />)}</ul>}
      {creating ? (
        <OwnTourForm onDone={(m) => { setCreating(false); onDone(m); }} onCancel={() => setCreating(false)} />
      ) : (
        <button type="button" className="ds-btn ds-btn-primary" onClick={() => setCreating(true)}>
          <Plus size={14} /> Новый тур
        </button>
      )}
    </div>
  );
}
