'use client';

/**
 * Переписка гостя с хозяином жилья на странице заявки (1349, #2843).
 *
 * Слово владельца 29.10: гостю — «MAX + страница заявки». Здесь гость видит
 * ответы владельца и пишет ему; кнопкой «Подключить MAX» он получает ответы
 * ещё и в мессенджер. Ключ заявки страница держит во фрагменте адреса и
 * передаёт сюда; в запросах он уходит только на /api/requests/stay-chat.
 *
 * Три исхода чтения (§4.0): переписка есть / пуста (сказано, что можно
 * написать) / не загрузилась (сказано словами, повтор раз в 20 секунд).
 * Сообщения переспрашиваются раз в 20 секунд, пока страница открыта.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { MessageCircle, Send, Loader2 } from 'lucide-react';

const MAX_LEN = 2000;

interface ChatMessage { author: 'owner' | 'guest'; body: string; at: string }
interface ChatData {
  accommodation: string;
  guest_on_max: boolean;
  owner_on_max: boolean;
  max_link: string | null;
  messages: ChatMessage[];
}

function timeRu(iso: string): string {
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? '' : t.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const DELIVERY_NOTE: Record<string, string> = {
  max: 'Передано владельцу.',
  no_address: 'Владелец пока не подключил MAX: сообщение получил оператор Ведара и передаст его.',
  failed: 'Передать владельцу сразу не удалось — оператор Ведара получил сообщение и передаст его.',
};

export function StayChat({ requestKey }: { requestKey: string }) {
  const [data, setData] = useState<ChatData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const activeKey = useRef(requestKey);

  const load = useCallback(async () => {
    const asked = requestKey;
    try {
      const res = await fetch(`/api/requests/stay-chat?k=${encodeURIComponent(asked)}`, { cache: 'no-store' });
      const body = await res.json().catch(() => null) as { success: true; data: ChatData } | { success: false; error?: string } | null;
      if (activeKey.current !== asked) return;
      if (!res.ok || !body || !body.success) {
        setLoadError((body && !body.success && body.error) || `Сервер ответил ${res.status}`);
        return;
      }
      setLoadError(null);
      setData(body.data);
    } catch {
      if (activeKey.current !== asked) return;
      setLoadError('Нет связи с сервером.');
    }
  }, [requestKey]);

  useEffect(() => {
    activeKey.current = requestKey;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- первая загрузка по ключу из адреса: источника до монтирования нет
    void load();
    const t = setInterval(() => { void load(); }, 20_000);
    return () => clearInterval(t);
  }, [requestKey, load]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;
    setSending(true);
    setSendError(null);
    setNote(null);
    try {
      const res = await fetch('/api/requests/stay-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ k: requestKey, text: body }),
      });
      const r = await res.json().catch(() => null) as { success: true; data: { delivery: string } } | { success: false; error?: string } | null;
      if (!res.ok || !r || !r.success) {
        setSendError((r && !r.success && r.error) || `Сервер ответил ${res.status}`);
        return;
      }
      setText('');
      setNote(DELIVERY_NOTE[r.data.delivery] ?? 'Сообщение записано.');
      await load();
    } catch {
      setSendError('Нет связи с сервером. Сообщение не отправлено.');
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="ds-card p-6 space-y-4" aria-labelledby="stay-chat-title">
      <h2 id="stay-chat-title" className="text-lg font-bold text-[var(--text-primary)] flex items-center gap-2" style={{ fontFamily: 'var(--font-playfair)' }}>
        <MessageCircle className="w-5 h-5" style={{ color: 'var(--ocean)' }} />
        Переписка с владельцем
      </h2>

      {!data && !loadError && (
        <p className="text-sm text-[var(--text-secondary)] flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Загружаем переписку…
        </p>
      )}
      {loadError && (
        <p className="text-sm text-[var(--danger)]" role="alert">
          {data ? `${loadError} Показаны последние загруженные сообщения.` : `Переписка не загрузилась: ${loadError} Пробуем ещё раз…`}
        </p>
      )}

      {data && (
        <>
          {data.messages.length === 0 ? (
            <p className="text-sm text-[var(--text-secondary)]">
              Сообщений пока нет. Напишите владельцу — например, уточнить заезд или дорогу. Он ответит здесь или позвонит.
            </p>
          ) : (
            <ol className="space-y-3" aria-label="Сообщения">
              {data.messages.map((m, i) => (
                <li
                  key={`${m.at}-${i}`}
                  className={`rounded-lg px-3 py-2 text-sm max-w-[85%] ${m.author === 'guest' ? 'ml-auto bg-[var(--bg-hover)]' : 'mr-auto border border-[var(--border)]'}`}
                >
                  <p className="text-xs text-[var(--text-muted)] mb-1">
                    {m.author === 'guest' ? 'Вы' : `Владелец · ${data.accommodation}`} · {timeRu(m.at)}
                  </p>
                  <p className="whitespace-pre-wrap break-words text-[var(--text-primary)]">{m.body}</p>
                </li>
              ))}
            </ol>
          )}

          <form onSubmit={send} className="space-y-2">
            <label htmlFor="stay-chat-text" className="ds-label">Сообщение владельцу</label>
            <textarea
              id="stay-chat-text"
              className="ds-input w-full min-h-[88px]"
              value={text}
              maxLength={MAX_LEN}
              onChange={(e) => setText(e.target.value)}
              placeholder="Например: во сколько можно заехать?"
            />
            <button type="submit" className="ds-btn ds-btn-primary w-full inline-flex items-center justify-center gap-2" disabled={sending || !text.trim()}>
              {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              {sending ? 'Отправляем…' : 'Отправить'}
            </button>
            {sendError && <p className="text-sm text-[var(--danger)]" role="alert">{sendError}</p>}
            {note && <p className="text-sm text-[var(--text-secondary)]" aria-live="polite">{note}</p>}
          </form>

          {data.guest_on_max ? (
            <p className="text-sm text-[var(--text-secondary)]">MAX подключён: ответы владельца приходят и туда.</p>
          ) : data.max_link ? (
            <div className="space-y-1 pt-3 border-t border-[var(--border)]">
              <a href={data.max_link} target="_blank" rel="noopener noreferrer" className="ds-btn ds-btn-secondary w-full text-center">
                Подключить MAX
              </a>
              <p className="text-xs text-[var(--text-muted)]">
                Откроется бот Ведара: нажмите «Старт», и ответы владельца будут приходить в MAX. Эту ссылку никому не пересылайте — по ней читают вашу переписку.
              </p>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
