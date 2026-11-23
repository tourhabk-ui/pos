import type { TourEditChange } from '@/lib/tours/moderation';
import { openablePhotoAddress } from '@/lib/tours/photo-address';

/**
 * Снимки поля — превью; открываются целиком по нажатию.
 *
 * Адрес — строка от партнёра. Ссылкой и картинкой становится только путь
 * нашего сайта или http(s); всё остальное показано текстом, без ссылки:
 * `javascript:` в ссылке очереди выполнился бы от имени администратора.
 */
export function TourEditPhotos({ urls, label }: { urls: string[]; label: string }) {
  if (urls.length === 0) return <p className="text-sm text-[var(--text-muted)]">снимков нет</p>;
  return (
    <ul className="flex flex-wrap gap-2" aria-label={label}>
      {urls.map((url, i) => {
        const address = openablePhotoAddress(url);
        if (address === null) {
          return (
            <li key={`${url}-${i}`} data-testid="photo-not-openable" className="max-w-full rounded-lg border border-[var(--warning)] p-2">
              <p className="text-xs font-medium text-[var(--warning)]">Адрес снимка не открывается</p>
              <p className="text-xs text-[var(--text-muted)] break-all">{url}</p>
            </li>
          );
        }
        return (
          <li key={`${url}-${i}`}>
            <a href={address} target="_blank" rel="noopener noreferrer" className="block">
              {/* Снимок партнёра по адресу из его правки: превью без оптимизатора, как в редакторе тура. */}
              {/* Адрес страницы проверки чужому серверу не сообщаем: rel на ссылке запрос картинки не покрывает. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={address}
                alt={`${label}, снимок ${i + 1}`}
                loading="lazy"
                referrerPolicy="no-referrer"
                className="h-20 w-28 rounded-lg border border-[var(--border)] object-cover"
              />
            </a>
          </li>
        );
      })}
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
          <dt className="text-sm font-medium text-[var(--text-primary)]">
            {change.label}
            {change.proposedBy ? (
              <span data-testid="tour-edit-proposed-by" className="block text-xs font-normal text-[var(--text-muted)]">
                Предложил автомат платформы: {change.proposedBy}
              </span>
            ) : null}
          </dt>
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
