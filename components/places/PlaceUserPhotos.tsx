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
 *
 * СВОЙ СНИМОК ВИДЕН ВСЕГДА (14.09). Владелец: «я лично загружал свои фото и
 * их нет». Путь работал ровно как написан — снимок лёг в `pending`, а блок
 * показывал только `approved`, — и человек, приславший фото, не мог отличить
 * «ещё не проверили» от «не загрузилось»: пусто и там и там. Теперь свой
 * снимок приходит в любом состоянии и НАЗЫВАЕТ его словами. Чужие
 * непроверенные по-прежнему не показываются никому.
 */

import { useCallback, useEffect, useState } from 'react';
import { Camera, Star, Loader2 } from 'lucide-react';

interface UserPhoto {
  id: string;
  url: string;
  caption: string | null;
  created_at: string;
  /** 'pending' | 'approved' | 'rejected'. Чужие непроверенные сюда не приходят. */
  status?: string | null;
  /** Снимок прислал тот, кто сейчас смотрит. */
  mine?: boolean;
}

/**
 * Подпись состояния для СВОЕГО снимка (владелец 14.09: «я лично загружал свои
 * фото и их нет»). Одобренный подписи не требует — он просто фото; остальные
 * обязаны назвать своё состояние словами, иначе «ещё не проверили» неотличимо
 * от «не загрузилось».
 */
function ownStatusLabel(p: UserPhoto): string | null {
  if (!p.mine) return null;
  if (p.status === 'pending') return 'Ждёт проверки — видно только вам';
  if (p.status === 'rejected') return 'Отклонено модератором';
  return null;
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
  /**
   * Админ ли смотрящий. Спрашивается у сервера, а не выводится из чего-либо
   * на клиенте: кнопка «сделать главным» лишь ПОКАЗЫВАЕТСЯ по этому флагу,
   * а право проверяет роут (requireAdmin). Три состояния, и «пока не знаю»
   * не равно «нет» — кнопка не мигает на медленной сети.
   */
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [heroBusy, setHeroBusy] = useState<string | null>(null);
  const [heroNote, setHeroNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/auth/me', { credentials: 'include' });
        if (!res.ok) { if (!cancelled) setIsAdmin(false); return; }
        // Контракт /api/auth/me: { success, data: { role, roles } }. Берём
        // АКТИВНУЮ роль, а не список owned: сервер (requireAdmin) судит по
        // ней же, и кнопка, показанная по другому признаку, обещала бы то,
        // в чём роут откажет.
        const json = (await res.json()) as { data?: { role?: string } };
        if (!cancelled) setIsAdmin(json?.data?.role === 'admin');
      } catch {
        if (!cancelled) setIsAdmin(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  /** Сделать снимок главным фото карточки (владелец 14.09). */
  const makeHero = useCallback(async (photoId: string) => {
    setHeroBusy(photoId);
    setHeroNote(null);
    try {
      const res = await fetch(`/api/admin/user-photos/${photoId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action: 'make_hero' }),
      });
      const json = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
      // Исход называется словами в обоих случаях: молчащая кнопка неотличима
      // от сломанной (тот же урок, что у «поделиться» на листе карты).
      if (res.ok && json.success) {
        setHeroNote('Готово — фото стало главным. Обновите страницу.');
      } else {
        setHeroNote(json.error ?? 'Не удалось сделать фото главным');
      }
    } catch {
      setHeroNote('Нет связи — попробуйте ещё раз');
    } finally {
      setHeroBusy(null);
    }
  }, []);

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

      {heroNote && (
        <p className="text-xs text-[var(--text-secondary)]" aria-live="polite">{heroNote}</p>
      )}

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
            {isAdmin === true && (
              <button
                type="button"
                onClick={() => { void makeHero(p.id); }}
                disabled={heroBusy !== null}
                className="w-full inline-flex items-center justify-center gap-1.5 text-[11px] font-semibold py-1.5 rounded-lg border border-[var(--border)] bg-[var(--bg-hover)] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-50"
              >
                {heroBusy === p.id
                  ? <Loader2 className="w-3 h-3 animate-spin" />
                  : <Star className="w-3 h-3" />}
                Сделать главным
              </button>
            )}
            {ownStatusLabel(p) && (
              <p className="text-[11px] text-[var(--warning)] leading-tight">{ownStatusLabel(p)}</p>
            )}
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
