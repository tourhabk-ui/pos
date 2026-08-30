'use client';

/**
 * components/places/PlaceUserPhotos.tsx
 *
 * Фото туристов на карточке места — одобренные модератором.
 *
 * ЗАЧЕМ ЗАВЕДЁН. До 30.08 путь фото обрывался на модерации: форма загрузки
 * (`PhotoUpload`) писала снимок в `user_place_photos` со статусом `pending`,
 * админ в `/hub/admin/user-photos` переводил его в `approved` — и на этом всё
 * заканчивалось. Одобренные снимки отдаёт `GET /api/places/[id]/photos`, но
 * этот адрес не вызывал НИ ОДИН компонент: ни одна страница не читала
 * `user_place_photos`, а герой карточки берёт фото из `ai_route_images`, куда
 * одобрение ничего не копирует.
 *
 * То есть форма обещала «Появятся после проверки модератором» — обещание,
 * которого система не могла сдержать ни при каком исходе модерации.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ БЛОК, А НЕ ГЕРОЙ. Снимок туриста и фото каталога — разные
 * по происхождению вещи, и смешивать их в одной галерее значит выдавать
 * любительский кадр за карточное фото. Здесь он подписан авторством места:
 * «сняли туристы».
 */

import { useEffect, useState } from 'react';
import { Camera } from 'lucide-react';

interface UserPhoto {
  id: string;
  url: string;
  caption: string | null;
  created_at: string;
}

/**
 * Три состояния вместо двух (CLAUDE.md 4.0): фото есть, фото нет, и
 * «спросить не смогли». Последнее не притворяется первыми двумя — блок
 * молчит, а не рисует пустоту с подписью «фотографий пока нет».
 */
type State =
  | { kind: 'loading' }
  | { kind: 'ready'; photos: UserPhoto[] }
  | { kind: 'failed' };

export default function PlaceUserPhotos({ placeId }: { placeId: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/places/${placeId}/photos`);
        if (!res.ok) {
          if (!cancelled) setState({ kind: 'failed' });
          return;
        }
        const json = (await res.json()) as { success?: boolean; data?: unknown };
        const rows = Array.isArray(json?.data) ? (json.data as UserPhoto[]) : [];
        if (!cancelled) setState({ kind: 'ready', photos: rows });
      } catch {
        if (!cancelled) setState({ kind: 'failed' });
      }
    })();
    return () => { cancelled = true; };
  }, [placeId]);

  // Пока грузится, не смогли спросить, или одобренных снимков нет — блока нет.
  // Пустой заголовок «Фото туристов» без единого фото ничего не сообщает.
  if (state.kind !== 'ready' || state.photos.length === 0) return null;

  return (
    <section className="max-w-3xl mx-auto px-4 space-y-3">
      <h2
        className="text-lg font-bold text-[var(--text-primary)] flex items-center gap-2"
        style={{ fontFamily: 'var(--font-playfair)' }}
      >
        <Camera className="w-5 h-5 text-[var(--ocean)]" />
        Сняли туристы
        <span className="text-base font-normal text-[var(--text-secondary)] ml-1">
          {state.photos.length}
        </span>
      </h2>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {state.photos.map((p) => (
          <figure key={p.id} className="space-y-1">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={p.url}
              alt={p.caption?.trim() || 'Фотография места, снятая туристом'}
              loading="lazy"
              className="w-full aspect-[4/3] object-cover rounded-lg border border-[var(--border)] bg-[var(--bg-hover)]"
            />
            {p.caption?.trim() && (
              <figcaption className="text-xs text-[var(--text-muted)] line-clamp-2">
                {p.caption.trim()}
              </figcaption>
            )}
          </figure>
        ))}
      </div>
    </section>
  );
}
