'use client';

/**
 * Программа дня, правила безопасности, видео и подпись снимков в форме тура
 * оператора (08.11). Кабинет гида получил их 05.11 по просьбе гида, а у
 * оператора программа, правила и клипы правились только миграцией или чатом:
 * блоки 6 и 9 карточки тура (§11) у оператора оставались пустыми.
 *
 * Поля и редакторы — те же, что у гида (components/guide/OwnTourExtras и
 * схема lib/guides/own-tour-edit), чтобы два кабинета не разошлись. Своё
 * здесь одно: в правку уходит только то, что оператор поменял. Туры из
 * миграций несут программы и клипы, которых форма раньше не касалась, и
 * пересылать их при каждом «Сохранить» значило бы ставить сохранение цены
 * в зависимость от старых данных, которых человек не трогал.
 */

import { Eye } from 'lucide-react';
import {
  ProgramEditor, ListField, VideosField, extrasGaps, extrasBody,
  type OwnClip,
} from '@/components/guide/OwnTourExtras';
import type { TourProgramStep } from '@/lib/tours/tour-write';

export interface OperatorTourExtras {
  program: TourProgramStep[];
  /** Правила безопасности тура — по одному на строке. */
  safety_notes: string;
  video_clips: OwnClip[];
  /** Подпись «Фото: …» к снимкам без подписи; пусто — не подписывать. */
  photo_credit: string;
}

/** Что пришло с туром из GET (программа и правила — как записаны). */
export function operatorExtrasOf(t: { program?: unknown; safety_notes?: unknown; video_clips?: unknown }): OperatorTourExtras {
  const program = Array.isArray(t.program)
    ? t.program.flatMap((s): TourProgramStep[] => {
      const o = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
      return typeof o.title === 'string' ? [{ title: o.title, text: typeof o.text === 'string' ? o.text : '' }] : [];
    })
    : [];
  const notes = Array.isArray(t.safety_notes) ? t.safety_notes.filter((s): s is string => typeof s === 'string') : [];
  const clips = Array.isArray(t.video_clips)
    ? t.video_clips.filter((c): c is OwnClip => !!c && typeof c === 'object'
      && ['key', 'poster', 'label', 'url', 'posterUrl'].every((k) => typeof (c as Record<string, unknown>)[k] === 'string'))
    : [];
  return { program, safety_notes: notes.join('\n'), video_clips: clips, photo_credit: '' };
}

const asFull = (x: OperatorTourExtras, photos: string[]) =>
  ({ ...x, photos, included: '', not_included: '', what_to_bring: '' });

/** Чего не хватает, чтобы отправить: тем же правилом, что у гида. */
export function operatorExtrasGaps(x: OperatorTourExtras, photos: string[]): string[] {
  return extrasGaps(asFull(x, photos));
}

/**
 * Поля правки: программа, правила и клипы — только изменённые против
 * загруженного; подпись — когда она есть и у тура есть фото.
 */
export function operatorExtrasBody(initial: OperatorTourExtras, x: OperatorTourExtras, photos: string[]): Record<string, unknown> {
  const now = extrasBody(asFull(x, photos));
  const was = extrasBody(asFull(initial, photos));
  const out: Record<string, unknown> = {};
  for (const k of ['program', 'safety_notes', 'video_clips'] as const) {
    if (JSON.stringify(now[k]) !== JSON.stringify(was[k])) out[k] = now[k];
  }
  if (typeof now.photo_credit === 'string') out.photo_credit = now.photo_credit;
  return out;
}

const SECTION = 'scroll-mt-20 bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-5 space-y-3';
const HEADING = 'text-xs font-semibold text-[var(--text-muted)] uppercase tracking-widest border-b border-[var(--border)] pb-1 mb-4';

export function TourProgramSection({ value, onChange }: {
  value: OperatorTourExtras;
  onChange: (x: OperatorTourExtras) => void;
}) {
  return (
    <section id="program" aria-labelledby="op-tour-program-h" className={SECTION}>
      <p id="op-tour-program-h" className={HEADING}>Программа тура</p>
      <ProgramEditor idBase="op-tour" steps={value.program} onChange={(program) => onChange({ ...value, program })} />
      <p className="text-xs text-[var(--text-muted)]">
        Программа идёт на карточку тура отдельным блоком — в описании её повторять не нужно.
      </p>
    </section>
  );
}

export function TourSafetySection({ value, onChange }: {
  value: OperatorTourExtras;
  onChange: (x: OperatorTourExtras) => void;
}) {
  return (
    <section id="safety" aria-labelledby="op-tour-safety-h" className={SECTION}>
      <p id="op-tour-safety-h" className={HEADING}>Безопасность</p>
      <ListField idBase="op-tour" field="safety_notes" value={value.safety_notes}
        onChange={(safety_notes) => onChange({ ...value, safety_notes })} />
      <p className="text-xs text-[var(--text-muted)]">
        Правила именно этого тура: на карточке они стоят рядом с живыми предупреждениями платформы. Общих правил за вас никто не допишет.
      </p>
    </section>
  );
}

export function TourVideosSection({ value, onChange, grabFrame }: {
  value: OperatorTourExtras;
  onChange: (x: OperatorTourExtras) => void;
  /** Снять кадр-обложку; в тестах подменяется. */
  grabFrame?: (f: File) => Promise<Blob>;
}) {
  return (
    <section id="videos" aria-labelledby="op-tour-videos-h" className={SECTION}>
      <p id="op-tour-videos-h" className={HEADING}>Видео ({value.video_clips.length})</p>
      <VideosField idBase="op-tour" clips={value.video_clips} grabFrame={grabFrame}
        onChange={(video_clips) => onChange({ ...value, video_clips })} />
      <p className="text-xs text-[var(--text-muted)]">Видео сохранятся вместе с туром кнопкой «Сохранить».</p>
    </section>
  );
}

/** Подпись «Фото: …»: уже подписанные снимки и автор для новых. */
export function PhotoCreditField({ photos, credits, value, onChange }: {
  photos: string[];
  /** Подписи, уже записанные (адрес → автор). */
  credits: Record<string, string>;
  value: OperatorTourExtras;
  onChange: (x: OperatorTourExtras) => void;
}) {
  const unsigned = photos.filter((p) => !credits[p]).length;
  return (
    <div className="space-y-1">
      <label className="block text-sm" htmlFor="op-tour-credit">
        <span className="text-[var(--text-secondary)]">Чьи снимки — подпись «Фото: …» под фото на странице тура</span>
        <input id="op-tour-credit" className="ds-input mt-1 w-full" value={value.photo_credit} maxLength={120}
          onChange={(e) => onChange({ ...value, photo_credit: e.target.value })} />
      </label>
      <p className="text-xs text-[var(--text-muted)]" data-testid="op-tour-credit-state">
        {photos.length === 0
          ? 'Фото нет — подписывать нечего.'
          : unsigned === 0
            ? 'Все фото подписаны.'
            : `Без подписи: ${unsigned} из ${photos.length}.${value.photo_credit.trim().length >= 2 ? ` После «Сохранить» им встанет «Фото: ${value.photo_credit.trim()}».` : ''} Уже подписанные не меняются.`}
      </p>
    </div>
  );
}

/** Подпись под снимком в сетке: записанный автор или «без подписи». */
export function photoCaption(url: string, credits: Record<string, string>): string {
  return credits[url] ? `Фото: ${credits[url]}` : 'Без подписи';
}

/**
 * «Как видит турист»: ссылка на карточку тура — только когда туристу её
 * показывает шлюз каталога. Тур не на витрине — сказано словами, без ссылки
 * в никуда.
 */
export function TouristViewLink({ tourId, onStorefront }: { tourId: string; onStorefront: boolean | null | undefined }) {
  if (onStorefront) {
    return (
      <a href={`/catalog/tours/${tourId}`} target="_blank" rel="noopener"
        className="inline-flex items-center gap-1 text-xs text-[var(--ocean)] hover:underline">
        <Eye className="w-3.5 h-3.5" aria-hidden /> Как видит турист
      </a>
    );
  }
  return <span className="text-xs text-[var(--text-muted)]">Туристы тур пока не видят: он не опубликован или выключен.</span>;
}
