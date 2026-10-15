'use client';

/**
 * Окно чата виджета партнёра (iframe из public/widget/embed.js на сайте
 * партнёра).
 *
 * Аудит 15.10, WID-safety:
 *  - Заявка — только формой. Чат больше не превращает первое сообщение в
 *    «лид» без телефона и согласия; вместо этого кнопка «Оставить заявку» (в
 *    шапке всегда и под ответом помощника) открывает в этом же окне ту же
 *    форму `/widget/lead-form/<slug>` — с телефоном, согласием на ПД и
 *    адресатом-партнёром. Разговор при этом не теряется: форма живёт во
 *    вложенном окне вместо ленты, «Закрыть» и Esc формы возвращают в чат.
 *    Хост и путь страницы партнёра окно передаёт в адрес формы (W3-widget).
 *  - Постоянная строка «Экстренно — 112» — текстом, не ссылкой tel:112.
 *    Своей SOS-кнопки и своего набора 112 здесь нет и быть не должно (§11,
 *    #887: SOS — только EmergencyAction, и в /widget он не монтируется);
 *    блок 112 при признаках ЧП ставит сервер в ответ.
 *  - Ошибки по-русски и с тремя исходами: чат не найден или выключен (404) —
 *    не то же, что «не загрузился» (сеть, сбой).
 *
 * Сторож: tests/unit/widget-chat-page.test.tsx (рендер).
 */

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { ArrowLeft, Send } from 'lucide-react';
import { trimWidgetHistory, type WidgetTurn } from '@/lib/embed/widget-chat-limits';
import { readWidgetOriginParams, type WidgetOriginInput } from '@/lib/embed/widget-origin';

interface PartnerConfig {
  name: string;
  greeting: string;
  accentColor: string;
  logo: string | null;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; config: PartnerConfig }
  | { kind: 'not_found' }
  | { kind: 'failed' };

const API_BASE = typeof window !== 'undefined'
  ? `${window.location.protocol}//${window.location.host}`
  : '';

const NOT_FOUND_TEXT = 'Чат этого партнёра не найден или выключен.';
const LOAD_FAILED_TEXT = 'Чат не загрузился — проверьте связь и обновите страницу. Экстренно — 112.';
const SEND_FAILED_TEXT = 'Не получилось получить ответ — попробуйте ещё раз. Экстренно — 112.';

/**
 * Адрес формы заявки партнёра — та же форма, что у кнопки lead.js.
 *
 * Хост и путь страницы партнёра (их положил в адрес этого окна embed.js)
 * передаются в адрес формы явно, как это делает lead.js: заявка из чата несёт
 * «откуда пришёл» своими параметрами, а не только через document.referrer,
 * который политика реферера может урезать. Без хоста — без обоих: путь без
 * хоста ни о чём не говорит (аудит 15.10, W3-widget, стык WID-safety и
 * WID-measure).
 */
function leadFormPath(slug: string, origin: WidgetOriginInput): string {
  const base = `/widget/lead-form/${encodeURIComponent(slug)}`;
  if (!origin.host) return base;
  const q = new URLSearchParams({ host: origin.host });
  if (origin.path) q.set('path', origin.path);
  return `${base}?${q.toString()}`;
}

export default function WidgetPage() {
  const params = useParams();
  const partnerId = params.partnerId as string;

  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });
  const [messages, setMessages] = useState<WidgetTurn[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [leadOpen, setLeadOpen] = useState(false);
  const [sessionId] = useState(() => `w_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const messagesEnd = useRef<HTMLDivElement>(null);
  const leadFrame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (!partnerId) return;
    fetch(`${API_BASE}/api/widget/partner/${encodeURIComponent(partnerId)}`)
      .then(async (r) => {
        if (r.status === 404) { setLoad({ kind: 'not_found' }); return; }
        const data: unknown = await r.json();
        const d = data as { success?: boolean; data?: PartnerConfig };
        if (r.ok && d.success && d.data) {
          setLoad({ kind: 'ready', config: d.data });
          setMessages([{ role: 'assistant', content: d.data.greeting }]);
        } else {
          setLoad({ kind: 'failed' });
        }
      })
      .catch(() => setLoad({ kind: 'failed' }));
  }, [partnerId]);

  useEffect(() => {
    messagesEnd.current?.scrollIntoView?.({ behavior: 'smooth' });
  }, [messages]);

  // Форма заявки сообщает о себе родителю: «Закрыть» и Esc — 'th:close'.
  // Родитель здесь — это окно чата, а не сайт партнёра: вернуть в разговор.
  useEffect(() => {
    if (!leadOpen) return;
    const onMessage = (e: MessageEvent) => {
      if (e.source !== leadFrame.current?.contentWindow) return;
      if (e.data === 'th:close') setLeadOpen(false);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [leadOpen]);

  async function sendMessage() {
    const text = input.trim();
    if (!text || sending || load.kind !== 'ready') return;

    // Приветствие — текст партнёра, не реплика разговора: в историю не идёт.
    const history = trimWidgetHistory(messages.slice(1));
    setMessages(prev => [...prev, { role: 'user', content: text }]);
    setInput('');
    setSending(true);

    try {
      const res = await fetch(`${API_BASE}/api/widget/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          partnerId,
          sessionId,
          message: text,
          history,
          // Хост и путь страницы партнёра из адреса окна (их кладёт embed.js).
          // Исход сверки со списком доменов ставит сервер; хост подделывается —
          // сигнал, а не замок (аудит 15.10, WID-measure).
          origin: readWidgetOriginParams(window.location.search),
        }),
      });
      const data = (await res.json()) as { success?: boolean; error?: string; data?: { answer?: string } };
      const answer = data.success ? data.data?.answer : undefined;
      const fallback = res.status === 400 && data.error ? `${data.error}.` : SEND_FAILED_TEXT;
      setMessages(prev => [...prev, { role: 'assistant', content: answer ?? fallback }]);
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', content: SEND_FAILED_TEXT }]);
    } finally {
      setSending(false);
    }
  }

  if (load.kind === 'not_found' || load.kind === 'failed') {
    return (
      <div role="alert" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', padding: 16, textAlign: 'center', fontFamily: 'system-ui, sans-serif', color: 'var(--text-secondary)' }}>
        {load.kind === 'not_found' ? NOT_FOUND_TEXT : LOAD_FAILED_TEXT}
      </div>
    );
  }

  if (load.kind === 'loading') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', fontFamily: 'system-ui, sans-serif', color: 'var(--text-secondary)' }}>
        Загрузка...
      </div>
    );
  }

  const config = load.config;
  const accent = config.accentColor || 'var(--accent)';
  // Ответ помощника на вопрос (не приветствие) — повод предложить заявку.
  const answered = messages.slice(1).some(m => m.role === 'assistant');

  const leadButton = (
    <button
      type="button"
      onClick={() => setLeadOpen(true)}
      style={{
        padding: '7px 12px',
        border: 'none',
        borderRadius: 16,
        background: accent,
        color: '#FFFFFF', // белый — на партнёрском акценте
        fontSize: 12,
        fontWeight: 600,
        fontFamily: 'inherit',
        cursor: 'pointer',
        flexShrink: 0,
      }}
    >
      Оставить заявку
    </button>
  );

  // Цвета — DS-токены (globals.css резолвится внутри iframe с нашего домена).
  // data-theme="light" пинит светлую тему: виджет живёт на партнёрских сайтах
  // и не должен темнеть от сохранённой темы посетителя на vedarai.ru.
  // Литеральный #FFFFFF — только текст на партнёрском акценте (accentColor
  // задаёт партнёр произвольным цветом, токены его не покрывают).
  return (
    <div data-theme="light" style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      fontFamily: "'Outfit', system-ui, sans-serif",
      background: 'var(--bg-primary)',
      color: 'var(--text-primary)',
    }}>

      {/* Header */}
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-card)',
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        flexShrink: 0,
      }}>
        {config.logo && (
          <img
            src={config.logo}
            alt={config.name}
            style={{ width: 28, height: 28, borderRadius: 6, objectFit: 'cover' }}
          />
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 14, lineHeight: 1.2 }}>
            {config.name}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
            Помощник Ведар AI
          </div>
        </div>
        {!leadOpen && leadButton}
      </div>

      {leadOpen ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <button
            type="button"
            onClick={() => setLeadOpen(false)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '8px 16px',
              border: 'none',
              borderBottom: '1px solid var(--border)',
              background: 'var(--bg-card)',
              color: 'var(--text-secondary)',
              fontSize: 13,
              fontFamily: 'inherit',
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            <ArrowLeft size={14} aria-hidden="true" />
            Вернуться в чат
          </button>
          <iframe
            ref={leadFrame}
            src={leadFormPath(partnerId, readWidgetOriginParams(window.location.search))}
            title={`Заявка партнёру ${config.name}`}
            style={{ flex: 1, width: '100%', border: 'none', background: 'var(--bg-primary)' }}
          />
        </div>
      ) : (
        <>
          {/* Messages */}
          <div style={{
            flex: 1,
            overflowY: 'auto',
            padding: '16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
          }}>
            {messages.map((msg, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
                }}
              >
                <div style={{
                  maxWidth: '80%',
                  padding: '10px 14px',
                  borderRadius: msg.role === 'user' ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                  background: msg.role === 'user' ? accent : 'var(--bg-card)',
                  color: msg.role === 'user' ? '#FFFFFF' : 'var(--text-primary)', // белый — на партнёрском акценте
                  fontSize: 14,
                  lineHeight: 1.5,
                  boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}>
                  {msg.content}
                </div>
              </div>
            ))}

            {sending && (
              <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                <div style={{
                  padding: '10px 14px',
                  borderRadius: '16px 16px 16px 4px',
                  background: 'var(--bg-card)',
                  fontSize: 14,
                  color: 'var(--text-muted)',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
                }}>
                  Печатает...
                </div>
              </div>
            )}

            {answered && !sending && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  Хотите, чтобы партнёр подобрал поездку и позвонил?
                </span>
                {leadButton}
              </div>
            )}

            <div ref={messagesEnd} />
          </div>

          {/* Input */}
          <div style={{
            padding: '12px 16px',
            borderTop: '1px solid var(--border)',
            background: 'var(--bg-card)',
            display: 'flex',
            gap: '8px',
            alignItems: 'center',
            flexShrink: 0,
          }}>
            <input
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendMessage()}
              placeholder="Напишите сообщение..."
              aria-label="Сообщение помощнику"
              maxLength={2000}
              disabled={sending}
              style={{
                flex: 1,
                padding: '10px 14px',
                border: '1px solid var(--border)',
                borderRadius: 20,
                outline: 'none',
                fontSize: 14,
                fontFamily: 'inherit',
                background: 'var(--bg-primary)',
              }}
            />
            <button
              type="button"
              onClick={sendMessage}
              disabled={sending || !input.trim()}
              aria-label="Отправить"
              style={{
                width: 38,
                height: 38,
                borderRadius: '50%',
                border: 'none',
                background: input.trim() ? accent : 'var(--bg-secondary)',
                color: '#FFFFFF',
                cursor: input.trim() ? 'pointer' : 'default',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                transition: 'background 0.2s',
              }}
            >
              <Send size={16} />
            </button>
          </div>
        </>
      )}

      {/* Подвал: 112 — всегда, при любом экране окна. Строкой, не ссылкой
          tel:112: сырая ссылка на 112 вне EmergencyAction — вторая реализация
          SOS, и сторож sos-always-reachable её запрещает (#887, ревью
          WID-safety 15.10). Номер короткий — набрать его можно и так. */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 8,
        padding: '6px 16px',
        fontSize: 11,
        color: 'var(--text-muted)',
        background: 'var(--bg-card)',
        borderTop: '1px solid var(--border)',
        flexShrink: 0,
      }}>
        <strong style={{ color: 'var(--danger)', fontWeight: 600 }}>
          Экстренно — 112
        </strong>
        <span>
          Работает на <a href="https://vedarai.ru" target="_blank" rel="noopener noreferrer" style={{ color: accent, textDecoration: 'none' }}>Ведар AI</a>
        </span>
      </div>
    </div>
  );
}
