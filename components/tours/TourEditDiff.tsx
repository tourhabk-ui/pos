import type { TourEditChange } from '@/lib/tours/moderation';

/** Снимки поля — превью; открываются целиком по нажатию. */
export function TourEditPhotos({ urls, label }: { urls: string[]; label: string }) {
  if (urls.length === 0) return <p className="text-sm text-[var(--text-muted)]">снимков нет</p>;
  return (
    <ul className="flex flex-wrap gap-2" aria-label={label}>
      {urls.map((url, i) => (
        <li key={`${url}-${i}`}>
          <a href={url} target="_blank" rel="noopener noreferrer" className="block">
            {/* Снимок партнёра по адресу из его правки: превью без оптимизатора, как в редакторе тура. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={url}
              alt={`${label}, снимок ${i + 1}`}
              loading="lazy"
              className="h-20 w-28 rounded-lg border border-[var(--border)] object-cover"
            />
          </a>
        </li>
      ))}
    </ul>
  );
}

/** Значение поля: снимки — превью, остальное — текст с переносами. */
export function TourEditValue({ text, photos, label }: { text: string; photos?: string[]; label: string }) {
  if (photos) return <TourEditPhotos urls={photos} label={label} />;
  return <p className="text-sm text-[var(--text-primary)] whitespace-pre-wrap break-words">{text}</p>;
}

/**
 * Дифф правки тура «на сайте сейчас / станет» по полям (план готовности
 * 23.11, этап 4). Одна вёрстка у владельца тура и у администратора: оба
 * обязаны видеть одно и то же — что на витрине и что придёт на её место.
 */
export function TourEditDiff({ changes }: { changes: TourEditChange[] }) {
  if (changes.length === 0) return null;
  return (
    <dl className="space-y-3">
      {changes.map((change) => (
        <div key={change.field} data-testid="tour-edit-change">
          <dt className="text-sm font-medium text-[var(--text-primary)]">{change.label}</dt>
          <dd className="grid gap-2 sm:grid-cols-2">
            <div>
              <p className="text-xs text-[var(--text-muted)]">На сайте сейчас</p>
              <TourEditValue text={change.before} photos={change.beforePhotos} label={`${change.label}: сейчас`} />
            </div>
            <div>
              <p className="text-xs text-[var(--text-muted)]">Станет</p>
              <TourEditValue text={change.after} photos={change.afterPhotos} label={`${change.label}: станет`} />
            </div>
          </dd>
        </div>
      ))}
    </dl>
  );
}
