'use client';

/**
 * Программа дня, списки и фото своего тура гида — в форме правки на сайте
 * (05.11). До этого дня их можно было поменять только фразой в чате бота или
 * документом Word в MAX, и гид Андрей Запорожец написал: «непонятно, как
 * отредактировать программу или добавить фото к туру (в первую очередь)».
 *
 * Пределы — те же, что у сервера (`OwnTourEditSchema`, LIMITS правки в чате):
 * форма говорит словами, чего не хватает, а не молчит кнопкой.
 */

import { useState } from 'react';
import { Loader2, Plus, Trash2, ArrowUp, ImagePlus, Star } from 'lucide-react';
import { LIMITS } from '@/lib/guides/tour-edit/parse';
import type { TourProgramStep } from '@/lib/tours/tour-write';

/** Сколько фото у тура — как у сервера (OWN_TOUR_PHOTOS_MAX). */
export const PHOTOS_MAX = 20;

export interface ExtrasValues {
  program: TourProgramStep[];
  included: string;
  not_included: string;
  what_to_bring: string;
  safety_notes: string;
  photos: string[];
}

export type ListKey = 'included' | 'not_included' | 'what_to_bring' | 'safety_notes';

export const LIST_LABELS: Readonly<Record<ListKey, string>> = {
  included: 'Что включено',
  not_included: 'Что не входит в цену',
  what_to_bring: 'Что взять с собой',
  safety_notes: 'Правила безопасности тура',
};

/** Строки списка: по одной на строке, пустые не считаются. */
export function listLines(text: string): string[] {
  return text.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Чего не хватает, чтобы отправить программу, списки и фото. */
export function extrasGaps(v: ExtrasValues): string[] {
  const gaps: string[] = [];
  if (v.program.length > LIMITS.programSteps) gaps.push(`программа — не больше ${LIMITS.programSteps} шагов`);
  v.program.forEach((s, i) => {
    if (s.title.trim().length === 0 && s.text.trim().length > 0) gaps.push(`у шага программы ${i + 1} нет названия`);
  });
  for (const key of Object.keys(LIST_LABELS) as ListKey[]) {
    if (listLines(v[key]).length > LIMITS.listItems) gaps.push(`${LIST_LABELS[key].toLowerCase()} — не больше ${LIMITS.listItems} строк`);
  }
  if (v.photos.length > PHOTOS_MAX) gaps.push(`фото — не больше ${PHOTOS_MAX}`);
  return gaps;
}

/** Тело PATCH для этих полей: пустое — null («снять»), а не пустой массив. */
export function extrasBody(v: ExtrasValues): Record<string, unknown> {
  const steps = v.program
    .map((s) => ({ title: s.title.trim(), text: s.text.trim() }))
    .filter((s) => s.title.length > 0);
  const body: Record<string, unknown> = { program: steps.length > 0 ? steps : null, photos: v.photos };
  for (const key of Object.keys(LIST_LABELS) as ListKey[]) {
    const lines = listLines(v[key]);
    body[key] = lines.length > 0 ? lines : null;
  }
  return body;
}

export function ProgramEditor({ idBase, steps, onChange }: {
  idBase: string;
  steps: TourProgramStep[];
  onChange: (steps: TourProgramStep[]) => void;
}) {
  const put = (i: number, patch: Partial<TourProgramStep>) =>
    onChange(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm text-[var(--text-secondary)]">Программа — по шагам: день или этап и что в нём</legend>
      {steps.length === 0 && <p className="text-sm text-[var(--text-muted)]">Программа не записана.</p>}
      {steps.map((s, i) => (
        <div key={i} className="rounded-lg border border-[var(--border)] p-3 space-y-2" data-testid={`program-step-${i}`}>
          <label className="block text-sm" htmlFor={`${idBase}-step-${i}-title`}>
            <span className="text-[var(--text-secondary)]">Шаг {i + 1} — название</span>
            <input id={`${idBase}-step-${i}-title`} className="ds-input mt-1 w-full" value={s.title} maxLength={LIMITS.stepTitle}
              onChange={(e) => put(i, { title: e.target.value })} />
          </label>
          <label className="block text-sm" htmlFor={`${idBase}-step-${i}-text`}>
            <span className="text-[var(--text-secondary)]">Шаг {i + 1} — что происходит</span>
            <textarea id={`${idBase}-step-${i}-text`} className="ds-input mt-1 w-full min-h-20" value={s.text} maxLength={LIMITS.stepText}
              onChange={(e) => put(i, { text: e.target.value })} />
          </label>
          <div className="flex flex-wrap gap-2">
            {i > 0 && (
              <button type="button" className="ds-btn ds-btn-secondary"
                onClick={() => onChange(steps.map((x, j) => (j === i - 1 ? steps[i] : j === i ? steps[i - 1] : x)))}>
                <ArrowUp size={14} aria-hidden /> Выше
              </button>
            )}
            <button type="button" className="ds-btn ds-btn-secondary" onClick={() => onChange(steps.filter((_, j) => j !== i))}>
              <Trash2 size={14} aria-hidden /> Убрать шаг {i + 1}
            </button>
          </div>
        </div>
      ))}
      {steps.length < LIMITS.programSteps && (
        <button type="button" className="ds-btn ds-btn-secondary" onClick={() => onChange([...steps, { title: '', text: '' }])}>
          <Plus size={14} aria-hidden /> Добавить шаг
        </button>
      )}
    </fieldset>
  );
}

export function ListField({ idBase, field, value, onChange }: {
  idBase: string;
  field: ListKey;
  value: string;
  onChange: (text: string) => void;
}) {
  return (
    <label className="block text-sm" htmlFor={`${idBase}-${field}`}>
      <span className="text-[var(--text-secondary)]">{LIST_LABELS[field]} — по одному пункту на строке</span>
      <textarea id={`${idBase}-${field}`} className="ds-input mt-1 w-full min-h-20" value={value}
        onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

/** Загрузка одного снимка: адрес из ответа или слова отказа сервера. */
async function uploadPhoto(file: File): Promise<{ url: string } | { error: string }> {
  try {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/upload/tour-photo', { method: 'POST', body: form });
    const json = await res.json().catch(() => null) as { url?: unknown; error?: unknown } | null;
    if (res.ok && typeof json?.url === 'string') return { url: json.url };
    return { error: typeof json?.error === 'string' ? json.error : `не загрузилось (HTTP ${res.status})` };
  } catch {
    return { error: 'сеть недоступна — не загрузилось' };
  }
}

export function PhotosField({ idBase, photos, onChange }: {
  idBase: string;
  photos: string[];
  onChange: (photos: string[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);

  const add = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    setProblems([]);
    const room = PHOTOS_MAX - photos.length;
    const picked = Array.from(files);
    const next = [...photos];
    const errs: string[] = [];
    for (const f of picked.slice(0, Math.max(0, room))) {
      const r = await uploadPhoto(f);
      if ('url' in r) next.push(r.url);
      else errs.push(`${f.name}: ${r.error}`);
    }
    if (picked.length > room) errs.push(`не больше ${PHOTOS_MAX} фото — лишние не загружены`);
    setBusy(false);
    setProblems(errs);
    onChange(next);
  };

  return (
    <fieldset className="space-y-2">
      <legend className="text-sm text-[var(--text-secondary)]">Фото — первое главное, его видят в каталоге</legend>
      {photos.length === 0 && <p className="text-sm text-[var(--text-muted)]">Фото нет.</p>}
      {photos.length > 0 && (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {photos.map((url, i) => (
            <li key={url} className="space-y-1" data-testid={`own-tour-photo-${i}`}>
              {/* eslint-disable-next-line @next/next/no-img-element -- превью загруженного, без оптимизатора (images.unoptimized) */}
              <img src={url} alt={i === 0 ? 'Главное фото тура' : `Фото тура ${i + 1}`} className="aspect-[4/3] w-full rounded-lg object-cover" />
              <div className="flex flex-wrap gap-1">
                {i === 0
                  ? <span className="ds-badge"><Star size={12} aria-hidden /> Главное</span>
                  : (
                    <button type="button" className="ds-btn ds-btn-secondary"
                      onClick={() => onChange([url, ...photos.filter((_, j) => j !== i)])}>
                      Сделать главным
                    </button>
                  )}
                <button type="button" className="ds-btn ds-btn-secondary" aria-label={`Убрать фото ${i + 1}`}
                  onClick={() => onChange(photos.filter((_, j) => j !== i))}>
                  <Trash2 size={14} aria-hidden /> Убрать
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {photos.length < PHOTOS_MAX && (
        <label className="ds-btn ds-btn-secondary cursor-pointer" htmlFor={`${idBase}-photos`}>
          {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <ImagePlus size={14} aria-hidden />}
          {busy ? 'Загружаю…' : 'Добавить фото'}
          <input id={`${idBase}-photos`} type="file" accept="image/jpeg,image/png,image/webp,image/heic" multiple className="sr-only"
            disabled={busy} aria-label="Добавить фото" onChange={(e) => { void add(e.target.files); e.target.value = ''; }} />
        </label>
      )}
      {problems.length > 0 && (
        <ul role="alert" className="text-sm text-[var(--danger)]">
          {problems.map((p) => <li key={p}>{p}</li>)}
        </ul>
      )}
      <p className="text-sm text-[var(--text-muted)]">Фото сохранятся вместе с туром кнопкой «Сохранить». Видео через сайт пока не добавить — пришлите ролик менеджеру платформы.</p>
    </fieldset>
  );
}
