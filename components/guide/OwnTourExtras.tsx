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
import { Loader2, Plus, Trash2, ArrowUp, ImagePlus, Star, Film, FileSignature } from 'lucide-react';
import { LIMITS } from '@/lib/guides/tour-edit/parse';
import type { TourProgramStep } from '@/lib/tours/tour-write';
import { MEDIA_CACHE_CONTROL } from '@/lib/storage/media-cache';
import { mp4VideoCodec, codecAdvice, HOW_TO_H264 } from '@/lib/media/mp4-codec';
import { MAX_TOUR_CLIPS } from '@/lib/tours/clip-limit';

/** Сколько фото у тура — как у сервера (OWN_TOUR_PHOTOS_MAX). */
export const PHOTOS_MAX = 20;

export interface OwnClip { key: string; poster: string; label: string; url: string; posterUrl: string }

/** Сколько видео у тура — то же число, что у карточки и сервера (lib/tours/clip-limit). */
export const CLIPS_MAX = MAX_TOUR_CLIPS;

export interface ExtrasValues {
  program: TourProgramStep[];
  included: string;
  not_included: string;
  what_to_bring: string;
  safety_notes: string;
  photos: string[];
  video_clips: OwnClip[];
  /** Подпись «Фото: …» к снимкам без подписи. */
  photo_credit: string;
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
  if (v.video_clips.length > CLIPS_MAX) gaps.push(`видео — не больше ${CLIPS_MAX}`);
  return gaps;
}

/** Тело PATCH для этих полей: пустое — null («снять»), а не пустой массив. */
export function extrasBody(v: ExtrasValues): Record<string, unknown> {
  const steps = v.program
    .map((s) => ({ title: s.title.trim(), text: s.text.trim() }))
    .filter((s) => s.title.length > 0);
  const body: Record<string, unknown> = {
    program: steps.length > 0 ? steps : null,
    photos: v.photos,
    video_clips: v.video_clips.map(({ key, poster, label }) => ({ key, poster, label: label.trim() || 'Видео тура' })),
  };
  if (v.photo_credit.trim().length >= 2 && v.photos.length > 0) body.photo_credit = v.photo_credit.trim();
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

export function PhotosField({ idBase, photos, onChange, credits = {}, credit, onCredit }: {
  idBase: string;
  photos: string[];
  onChange: (photos: string[]) => void;
  /** Подписи снимков, уже записанные (адрес → автор). */
  credits?: Record<string, string>;
  /** Подпись «Фото: …» к снимкам без подписи. */
  credit?: string;
  onCredit?: (credit: string) => void;
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
              <p className="text-xs text-[var(--text-muted)]">{credits[url] ? `Фото: ${credits[url]}` : credit?.trim() ? `Фото: ${credit.trim()} — после «Сохранить»` : 'Без подписи'}</p>
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
      {onCredit && (
        <label className="block text-sm" htmlFor={`${idBase}-credit`}>
          <span className="text-[var(--text-secondary)]">Чьи снимки — подпись «Фото: …» под фото на странице тура</span>
          <input id={`${idBase}-credit`} className="ds-input mt-1 w-full" value={credit ?? ''} maxLength={120}
            onChange={(e) => onCredit(e.target.value)} />
        </label>
      )}
      <p className="text-sm text-[var(--text-muted)]">Фото сохранятся вместе с туром кнопкой «Сохранить».</p>
    </fieldset>
  );
}

/** Кадр ролика для обложки: браузер гида, а не сервер (ffmpeg на проде нет). */
export async function grabVideoFrame(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error('видео не открылось в браузере'));
    });
    video.currentTime = Math.min(1, (video.duration || 2) / 2);
    await new Promise<void>((resolve) => { video.onseeked = () => resolve(); });
    const w = Math.min(960, video.videoWidth || 960);
    const h = Math.round(w * ((video.videoHeight || 540) / (video.videoWidth || 960)));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d')?.drawImage(video, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    if (!blob) throw new Error('кадр не снялся');
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Записать байты прямо в хранилище по подписанной ссылке, с процентами. */
function putWithProgress(url: string, body: Blob, contentType: string, onProgress?: (pct: number) => void): Promise<boolean> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.setRequestHeader('Cache-Control', MEDIA_CACHE_CONTROL);
    if (onProgress) xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => resolve(xhr.status >= 200 && xhr.status < 300);
    xhr.onerror = () => resolve(false);
    xhr.send(body);
  });
}

async function answer(res: Response): Promise<{ ok: boolean; status: number; json: Record<string, unknown> | null }> {
  return { ok: res.ok, status: res.status, json: await res.json().catch(() => null) as Record<string, unknown> | null };
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/**
 * Видео — из браузера прямо в хранилище (05.11): сервер только подписывает
 * ссылки и потом проверяет, что объект лёг. Байты ролика через приложение не
 * идут.
 */
export async function uploadClip(
  file: File,
  grab: (f: File) => Promise<Blob>,
  onProgress?: (pct: number) => void,
): Promise<OwnClip | { error: string }> {
  // Кодек — из индекса файла, до попытки открыть ролик (07.11): MP4 с HEVC
  // или VP9 внутри у гида мог открыться, а у половины туристов — нет. Во всех
  // браузерах играет только H.264. Не разобрали индекс — решает браузер.
  const codec = await mp4VideoCodec(file).catch(() => null);
  if (codec && codec !== 'h264') return { error: codecAdvice(codec) };
  let poster: Blob;
  try {
    poster = await grab(file);
  } catch (e) {
    return { error: `обложку не снять (${e instanceof Error ? e.message : 'ошибка'}). Нужен MP4 с кодеком H.264. ${HOW_TO_H264}` };
  }
  try {
    const sign = await answer(await fetch('/api/upload/tour-video', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ videoSize: file.size, posterSize: poster.size }) }));
    const j = sign.json;
    if (!sign.ok || typeof j?.uploadUrl !== 'string' || typeof j.posterUploadUrl !== 'string' || typeof j.key !== 'string'
      || typeof j.poster !== 'string' || typeof j.url !== 'string' || typeof j.posterUrl !== 'string') {
      return { error: typeof j?.error === 'string' ? j.error : `не загрузилось (HTTP ${sign.status})` };
    }
    if (!await putWithProgress(j.uploadUrl, file, 'video/mp4', onProgress)) return { error: 'хранилище не приняло видео — попробуйте ещё раз' };
    if (!await putWithProgress(j.posterUploadUrl, poster, 'image/jpeg')) return { error: 'хранилище не приняло обложку — попробуйте ещё раз' };
    const done = await answer(await fetch('/api/upload/tour-video/confirm', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ key: j.key, poster: j.poster }) }));
    if (!done.ok) return { error: typeof done.json?.error === 'string' ? done.json.error : `не проверить загрузку (HTTP ${done.status})` };
    return { key: j.key, poster: j.poster, url: j.url, posterUrl: j.posterUrl, label: file.name.replace(/\.[^.]+$/, '') };
  } catch {
    return { error: 'сеть недоступна — не загрузилось' };
  }
}

export function VideosField({ idBase, clips, onChange, grabFrame = grabVideoFrame }: {
  idBase: string;
  clips: OwnClip[];
  onChange: (clips: OwnClip[]) => void;
  /** Снять кадр-обложку; в тестах подменяется. */
  grabFrame?: (f: File) => Promise<Blob>;
}) {
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const add = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setBusy(true);
    setProblem(null);
    setPct(null);
    const r = await uploadClip(file, grabFrame, setPct);
    setBusy(false);
    setPct(null);
    if ('error' in r) { setProblem(`${file.name}: ${r.error}`); return; }
    onChange([...clips, r]);
  };
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm text-[var(--text-secondary)]">Видео — MP4 с кодеком H.264, до 500 МБ, обложкой станет кадр из ролика</legend>
      {clips.length === 0 && <p className="text-sm text-[var(--text-muted)]">Видео нет.</p>}
      {clips.map((c, i) => (
        <div key={c.key} className="space-y-1" data-testid={`own-tour-clip-${i}`}>
          <video src={c.url} poster={c.posterUrl} controls preload="none" className="aspect-video w-full rounded-lg" aria-label={c.label} />
          <div className="flex flex-wrap items-end gap-2">
            <label className="block flex-1 text-sm" htmlFor={`${idBase}-clip-${i}`}>
              <span className="text-[var(--text-secondary)]">Подпись видео {i + 1}</span>
              <input id={`${idBase}-clip-${i}`} className="ds-input mt-1 w-full" value={c.label} maxLength={120}
                onChange={(e) => onChange(clips.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
            </label>
            <button type="button" className="ds-btn ds-btn-secondary" aria-label={`Убрать видео ${i + 1}`}
              onClick={() => onChange(clips.filter((_, j) => j !== i))}>
              <Trash2 size={14} aria-hidden /> Убрать
            </button>
          </div>
        </div>
      ))}
      {clips.length < CLIPS_MAX && (
        <label className="ds-btn ds-btn-secondary cursor-pointer" htmlFor={`${idBase}-video`}>
          {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Film size={14} aria-hidden />}
          {busy ? `Загружаю видео…${pct !== null ? ` ${pct}%` : ''}` : 'Добавить видео'}
          <input id={`${idBase}-video`} type="file" accept="video/mp4" className="sr-only" disabled={busy}
            aria-label="Добавить видео" onChange={(e) => { void add(e.target.files); e.target.value = ''; }} />
        </label>
      )}
      {problem && <p role="alert" className="text-sm text-[var(--danger)]">{problem}</p>}
    </fieldset>
  );
}

/**
 * Согласие на показ фото и видео (§0, миграция 1321): записанный текст, а не
 * слова. Кнопка открывает ту же страницу подписи, что ссылка менеджера.
 */
export function MaterialsConsent() {
  const [state, setState] = useState<{ kind: 'idle' | 'busy' } | { kind: 'signed'; on: string } | { kind: 'opened' } | { kind: 'error'; text: string }>({ kind: 'idle' });
  const ask = async () => {
    setState({ kind: 'busy' });
    try {
      const res = await fetch('/api/guide/own/material-consent', { method: 'POST' });
      const json = await res.json().catch(() => null) as { success?: boolean; url?: string; signedOn?: string; error?: string } | null;
      if (res.ok && json?.signedOn) { setState({ kind: 'signed', on: json.signedOn.split('-').reverse().join('.') }); return; }
      if (res.ok && json?.url) { window.open(json.url, '_blank', 'noopener'); setState({ kind: 'opened' }); return; }
      setState({ kind: 'error', text: json?.error ?? `не получилось (HTTP ${res.status})` });
    } catch {
      setState({ kind: 'error', text: 'сеть недоступна' });
    }
  };
  return (
    <div className="space-y-1 text-sm">
      <p className="text-[var(--text-secondary)]">
        Ваши фото и видео Ведар показывает по записанному согласию — его подписываете вы сами, один раз.
      </p>
      <button type="button" className="ds-btn ds-btn-secondary" disabled={state.kind === 'busy'} onClick={() => void ask()}>
        <FileSignature size={14} aria-hidden /> Согласие на показ фото и видео
      </button>
      {state.kind === 'signed' && <p className="text-[var(--text-secondary)]">Согласие подписано {state.on} — подписывать снова не нужно.</p>}
      {state.kind === 'opened' && <p className="text-[var(--text-secondary)]">Открылась страница подписи — прочитайте текст и подпишите.</p>}
      {state.kind === 'error' && <p role="alert" className="text-[var(--danger)]">Согласие: {state.text}</p>}
    </div>
  );
}
