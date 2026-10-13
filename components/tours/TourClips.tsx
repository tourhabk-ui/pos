'use client';

import { LazyClip } from '@/components/media/LazyClip';
import { OperatorNameLink } from '@/components/operators/OperatorNameLink';
import type { TourClip } from '@/lib/tours/tour-clips';

/**
 * Лента коротких клипов тура с подписью автора (решение владельца 09.10:
 * «нарежь короткие видео для туров камчатской рыбалки, без звука, и сохрани
 * их в S3»). Клипы — петли настроения без звука из хранилища; LazyClip не
 * качает файл, пока клип не подошёл к экрану, и не играет без связи.
 *
 * Автор клипа — оператор тура, тем же правилом, что у клипов перевозчика:
 * «Видео: <кто>», и с 13.10 имя ведёт на страницу оператора, если она
 * открыта (OperatorNameLink: закрытая карточка — имя текстом).
 *
 * Вынесено из карточки тура 13.10, чтобы сторож (tests/unit/tour-video-clips)
 * проверял ленту рендером, а не литералом разметки в 1300-строчном клиенте.
 */
export interface TourClipsProps {
  clips: TourClip[];
  operatorName: string;
  operatorSlug?: string | null;
  operatorPublic?: boolean | null;
}

export function TourClips({ clips, operatorName, operatorSlug, operatorPublic }: TourClipsProps) {
  if (clips.length === 0) return null;
  return (
    <>
      <ul className="flex gap-3 overflow-x-auto pb-2 snap-x" aria-label="Клипы тура">
        {clips.map((c) => (
          <li key={c.url} className="snap-start shrink-0 w-40 sm:w-44">
            <LazyClip url={c.url} poster={c.poster} label={c.label} className="aspect-[9/16]" />
            <p className="mt-1 text-xs leading-snug text-[var(--text-secondary)]">{c.label}</p>
          </li>
        ))}
      </ul>
      <p className="text-xs text-[var(--text-muted)]">
        Видео: <OperatorNameLink name={operatorName} slug={operatorSlug} isPublic={operatorPublic} />
      </p>
    </>
  );
}
