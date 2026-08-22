'use client';

/**
 * Фото места от туриста.
 *
 * Владелец 21.08, стоя на Диких озерках: «нужно выбирать до 5 фотографий, и
 * я то авторизован — почему пишет не авторизован?».
 *
 * ── Про «не авторизован» ───────────────────────────────────────────────────
 *
 * Эта строка приходила НЕ из загрузчика, а с Edge-гварда: до кода роута
 * запрос не доходил вовсе. Но узнавал об этом человек последним — уже выбрав
 * снимок, дождавшись превью и напечатав подпись. Форма делала вид, что
 * работает, и отказывала на последнем шаге.
 *
 * Вход спрашивается СРАЗУ и говорится словами, с ссылкой и возвратом на это
 * же место. Пока ответ не получен, кнопка не обещает: у состояния входа три
 * исхода — «вошёл», «не вошёл» и «пока не знаю», и третий не равен первому
 * (§4.0). Прежде третьего не было: форма молча считала, что вошёл.
 *
 * ── Про пять снимков ───────────────────────────────────────────────────────
 *
 * Потолок в пять фото на место и человека стоит на сервере с самого начала —
 * форма про него не знала и грузила по одному. Теперь выбираются сразу
 * несколько, а остаток берётся у сервера, не выдумывается: сколько уже
 * прислано с этого аккаунта, знает только он.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, Upload, X, CheckCircle, Loader2, LogIn, AlertTriangle } from 'lucide-react';

interface PhotoUploadProps {
  placeId: string;
  placeName: string;
}

/** Тот же потолок, что у роута: держим одно число в глазах и на сервере. */
const MAX_PHOTOS = 5;
const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic']);

/** Вошёл / не вошёл / пока не знаю. Третье — не «нет» и не «да». */
type AuthState = 'unknown' | 'in' | 'out';

interface Shot {
  file: File;
  preview: string;
  /** null — ещё не отправляли; строка — отказ сервера по этому снимку. */
  error: string | null;
  done: boolean;
}

export function PhotoUpload({ placeId, placeName }: PhotoUploadProps) {
  const [auth, setAuth] = useState<AuthState>('unknown');
  const [shots, setShots] = useState<Shot[]>([]);
  const [caption, setCaption] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentCount, setSentCount] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/auth/me', { credentials: 'include' })
      .then(r => { if (alive) setAuth(r.ok ? 'in' : 'out'); })
      // Сеть не ответила — это «не знаю», а не «не вошёл»: обвинять
      // человека в том, что он не залогинен, из-за пропавшей связи нельзя.
      .catch(() => { if (alive) setAuth('unknown'); });
    return () => { alive = false; };
  }, []);

  const addFiles = useCallback((list: FileList | null) => {
    if (!list || list.length === 0) return;
    setError(null);
    const room = MAX_PHOTOS - shots.length;
    if (room <= 0) {
      setError(`Больше ${MAX_PHOTOS} снимков за раз не отправить`);
      return;
    }
    const picked = Array.from(list).slice(0, room);
    if (list.length > room) {
      setError(`Взял первые ${room} — на место можно не больше ${MAX_PHOTOS}`);
    }
    const good: Shot[] = [];
    for (const f of picked) {
      if (!ALLOWED.has(f.type)) { setError(`${f.name}: только JPEG, PNG, WebP или HEIC`); continue; }
      if (f.size > MAX_BYTES) { setError(`${f.name}: больше 10 МБ`); continue; }
      good.push({ file: f, preview: URL.createObjectURL(f), error: null, done: false });
    }
    if (good.length > 0) setShots(prev => [...prev, ...good]);
  }, [shots.length]);

  // Ссылки на объекты живут до размонтирования: без отзыва браузер держит
  // снимки в памяти, а их тут до пяти и по десять мегабайт.
  useEffect(() => () => { shots.forEach(s => URL.revokeObjectURL(s.preview)); }, [shots]);

  const removeAt = (i: number) => {
    setShots(prev => {
      const s = prev[i];
      if (s) URL.revokeObjectURL(s.preview);
      return prev.filter((_, k) => k !== i);
    });
  };

  const submit = async () => {
    if (shots.length === 0 || busy) return;
    setBusy(true);
    setError(null);

    // По одному запросу на снимок: сервер считает потолок сам, и отказ по
    // третьему не должен отменять первые два. Отказ называется у того
    // снимка, к которому он относится, — общая красная строка врала бы
    // про все сразу.
    const next = [...shots];
    let ok = 0;
    for (let i = 0; i < next.length; i++) {
      if (next[i].done) { ok++; continue; }
      const fd = new FormData();
      fd.append('file', next[i].file);
      if (caption.trim()) fd.append('caption', caption.trim());
      try {
        const res = await fetch(`/api/places/${placeId}/photos`, {
          method: 'POST', body: fd, credentials: 'include',
        });
        const data = await res.json().catch(() => null) as { success?: boolean; error?: string } | null;
        if (res.status === 401) {
          setAuth('out');
          next[i] = { ...next[i], error: 'Нужен вход' };
          break;
        }
        if (!res.ok || !data?.success) {
          next[i] = { ...next[i], error: data?.error ?? `Отказ ${res.status}` };
        } else {
          next[i] = { ...next[i], done: true, error: null };
          ok++;
        }
      } catch {
        next[i] = { ...next[i], error: 'Нет соединения' };
      }
    }
    setShots(next);
    setSentCount(ok);
    setBusy(false);
  };

  const allDone = shots.length > 0 && shots.every(s => s.done);

  if (allDone) {
    return (
      <div className="ds-card p-5 flex flex-col items-center gap-3 text-center">
        <CheckCircle size={32} className="text-[var(--success)]" />
        <p className="font-semibold text-[var(--text-primary)]">
          {sentCount === 1 ? 'Фото отправлено' : `Отправлено фото: ${sentCount}`}
        </p>
        <p className="text-sm text-[var(--text-secondary)]">
          Появятся после проверки модератором.
        </p>
        <button
          onClick={() => { setShots([]); setCaption(''); setSentCount(0); setError(null); }}
          className="text-sm text-[var(--accent)] hover:underline">
          Добавить ещё
        </button>
      </div>
    );
  }

  const backHere = typeof window === 'undefined' ? '' : window.location.pathname;

  return (
    <div className="ds-card p-5">
      <div className="flex items-center gap-2 mb-4">
        <Camera size={18} className="text-[var(--ocean)]" />
        <h3 className="font-semibold text-[var(--text-primary)]">Добавить фото</h3>
      </div>
      <p className="text-sm text-[var(--text-secondary)] mb-4">
        Были в <span className="font-medium">{placeName}</span>? Поделитесь фото с другими
        туристами — до {MAX_PHOTOS} снимков.
      </p>

      {/* Вход спрашивается ДО выбора снимка, а не после подписи. */}
      {auth === 'out' && (
        <a href={`/auth/login${backHere ? `?from=${encodeURIComponent(backHere)}` : ''}`}
          className="ds-btn ds-btn-primary w-full flex items-center justify-center gap-2 mb-4">
          <LogIn size={16} />
          Войти, чтобы добавить фото
        </a>
      )}
      {auth === 'unknown' && (
        <p className="text-xs text-[var(--text-muted)] mb-4 flex items-center gap-2">
          <Loader2 size={12} className="animate-spin" />
          Проверяем вход
        </p>
      )}

      {auth !== 'out' && (
        <>
          {shots.length < MAX_PHOTOS && (
            <div
              onDrop={e => { e.preventDefault(); addFiles(e.dataTransfer.files); }}
              onDragOver={e => e.preventDefault()}
              onClick={() => inputRef.current?.click()}
              className="border-2 border-dashed border-[var(--border)] rounded-lg p-6 text-center cursor-pointer hover:border-[var(--accent)] transition-colors"
            >
              <Upload size={24} className="mx-auto text-[var(--text-muted)] mb-2" />
              <p className="text-sm text-[var(--text-secondary)]">
                Перетащите фото или{' '}
                <span className="text-[var(--accent)] underline">выберите файлы</span>
              </p>
              <p className="text-xs text-[var(--text-muted)] mt-1">
                JPEG, PNG, WebP — до 10 МБ. Осталось мест: {MAX_PHOTOS - shots.length}
              </p>
              <input
                ref={inputRef}
                type="file"
                multiple
                accept="image/jpeg,image/png,image/webp,image/heic"
                className="hidden"
                onChange={e => { addFiles(e.target.files); if (inputRef.current) inputRef.current.value = ''; }}
              />
            </div>
          )}

          {shots.length > 0 && (
            <div className="grid grid-cols-3 gap-2 mt-3">
              {shots.map((s, i) => (
                <div key={`${s.file.name}-${i}`} className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={s.preview} alt={`Снимок ${i + 1}`}
                    className="w-full h-24 object-cover rounded-lg"
                    style={{ opacity: s.done ? 0.55 : 1 }} />
                  {s.done ? (
                    <span className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/60 flex items-center justify-center">
                      <CheckCircle size={13} className="text-[var(--success)]" />
                    </span>
                  ) : (
                    <button onClick={() => removeAt(i)} aria-label="Убрать снимок"
                      className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/60 flex items-center justify-center text-white hover:bg-black/80">
                      <X size={12} />
                    </button>
                  )}
                  {s.error && (
                    <span className="block text-[10px] leading-tight mt-1 text-[var(--danger)]">
                      {s.error}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {shots.length > 0 && (
            <div className="mt-3">
              <input
                value={caption}
                onChange={e => setCaption(e.target.value)}
                placeholder="Подпись ко всем снимкам (необязательно)"
                maxLength={300}
                className="ds-input w-full text-sm"
              />
            </div>
          )}

          {error && (
            <p className="mt-2 text-sm text-[var(--danger)] flex items-start gap-2">
              <AlertTriangle size={14} className="shrink-0 mt-0.5" />
              <span>{error}</span>
            </p>
          )}

          {shots.length > 0 && (
            <button
              onClick={() => void submit()}
              disabled={busy}
              className="mt-3 ds-btn ds-btn-primary w-full flex items-center justify-center gap-2"
            >
              {busy ? (
                <><Loader2 size={16} className="animate-spin" /> Отправляем…</>
              ) : (
                <>
                  <Upload size={16} />
                  {shots.length === 1 ? 'Отправить на проверку' : `Отправить ${shots.length} на проверку`}
                </>
              )}
            </button>
          )}
        </>
      )}
    </div>
  );
}
