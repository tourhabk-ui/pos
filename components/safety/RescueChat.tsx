'use client';

/**
 * AI Спасатель — один на радар (/safety) и SOS (/sos).
 *
 * Владелец 04.10, скрин /sos: «в сос нет ai спасателя». Чат жил прямо в
 * радаре, а с /sos вела ссылка на хаб — человеку в беде предлагалось уйти со
 * страницы с координатами и кнопкой 112. Теперь чат вынесен сюда целиком
 * (логика радара без изменений), и /sos ставит его ниже звонка, координат и
 * шагов «Что делать» — они главнее и не уезжают вниз.
 *
 * Без сети отвечает офлайн-протокол (lib/safety/rescue-protocols): совпало
 * слово — ответ сразу; не совпало — «Позвоните 112», без выдумки.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, Send, ChevronDown, ChevronUp } from 'lucide-react';
import { getLocalProtocol, OFFLINE_NO_PROTOCOL } from '@/lib/safety/rescue-protocols';

interface RescueMsg {
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
}

/**
 * Поверхность. `card` — карточка дизайн-системы (радар). `sos` — экран SOS,
 * тёмный всегда, в той же манере, что остальные блоки /sos (белая альфа на
 * тёмном). Не `data-theme="dark"`: он переопределял бы --accent и --danger на
 * острове, а на экране SOS цвет тревоги и кнопок обязан быть одним (token-gate).
 */
type Surface = 'card' | 'sos';

const SKIN: Record<Surface, {
  box: React.CSSProperties; title: string; sub: string; muted: string; line: string;
  bubble: string; bubbleText: string; input: React.CSSProperties;
}> = {
  card: {
    box: {}, title: 'var(--text-primary)', sub: 'var(--text-secondary)', muted: 'var(--text-muted)',
    line: '1px solid var(--border)', bubble: 'var(--bg-hover)', bubbleText: 'var(--text-primary)', input: {},
  },
  sos: {
    box: { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12 },
    title: 'rgba(255,255,255,0.92)', sub: 'rgba(255,255,255,0.55)', muted: 'rgba(255,255,255,0.45)',
    line: '1px solid rgba(255,255,255,0.1)', bubble: 'rgba(255,255,255,0.08)', bubbleText: 'rgba(255,255,255,0.9)',
    input: { background: 'rgba(255,255,255,0.06)', color: 'white', borderColor: 'rgba(255,255,255,0.15)' },
  },
};

export default function RescueChat({ className, style, surface = 'card' }: { className?: string; style?: React.CSSProperties; surface?: Surface }) {
  const k = SKIN[surface];
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<RescueMsg[]>([]);
  const [loading, setLoading] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [messages, open]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: text }]);
    setLoading(true);

    const local = getLocalProtocol(text);
    if (local || !navigator.onLine) {
      setMessages(prev => [...prev, { role: 'assistant', content: local ?? OFFLINE_NO_PROTOCOL }]);
      setLoading(false);
      return;
    }

    try {
      const history = messages.map(m => ({ role: m.role, content: m.content }));
      const res = await fetch('/api/safety/rescue-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history, stream: true }),
      });
      if (!res.ok || !res.body) throw new Error('no stream');
      // Роут мог ответить JSON-фолбэком вместо SSE — чтение его как стрима
      // давало пустой пузырь. Разбираем по content-type.
      if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
        const data = await res.json() as { reply?: string; error?: string };
        if (!data.reply) throw new Error('ai unavailable');
        setMessages(prev => [...prev, { role: 'assistant', content: data.reply as string }]);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let content = '';
      setMessages(prev => [...prev, { role: 'assistant', content: '', streaming: true }]);
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') break;
          try {
            const parsed = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] };
            content += parsed.choices?.[0]?.delta?.content ?? '';
            setMessages(prev => {
              const next = [...prev];
              next[next.length - 1] = { role: 'assistant', content, streaming: true };
              return next;
            });
          } catch { /* неполная строка SSE — придёт следующим куском */ }
        }
      }
      setMessages(prev => {
        const next = [...prev];
        next[next.length - 1] = { role: 'assistant', content, streaming: false };
        return next;
      });
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', content: 'Ошибка связи. В экстренной ситуации звоните 112.' }]);
    } finally {
      setLoading(false);
    }
  }, [input, loading, messages]);

  return (
    <div className={`${surface === 'card' ? 'ds-card ' : ''}${className ?? ''}`} style={{ overflow: 'hidden', ...k.box, ...style }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', background: 'none', border: 'none', cursor: 'pointer' }}
      >
        <Bot size={16} color="var(--ocean)" />
        <div style={{ textAlign: 'left' }}>
          <div style={{ fontWeight: 600, color: k.title, fontSize: 14 }}>AI Спасатель</div>
          <div style={{ color: k.sub, fontSize: 11 }}>Экстренные протоколы · работает офлайн</div>
        </div>
        <span style={{ marginLeft: 'auto', color: k.sub }}>
          {open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </span>
      </button>

      {open && (
        <div style={{ borderTop: k.line }}>
          <div style={{ height: 240, overflowY: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {messages.length === 0 && (
              <p style={{ color: k.muted, fontSize: 12, margin: 0 }}>Опишите ситуацию: медведь, травма, потеря, гипотермия, землетрясение...</p>
            )}
            {messages.map((m, i) => (
              <div key={i} style={{
                alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '85%',
                background: m.role === 'user' ? 'var(--ocean)' : k.bubble,
                color: m.role === 'user' ? '#fff' : k.bubbleText,
                padding: '8px 12px',
                borderRadius: 10,
                fontSize: 13,
                whiteSpace: 'pre-wrap',
              }}>
                {m.content}{m.streaming ? '▋' : ''}
              </div>
            ))}
            <div ref={endRef} />
          </div>
          <div style={{ borderTop: k.line, display: 'flex', gap: 8, padding: '10px 12px' }}>
            <input
              className="ds-input"
              style={{ flex: 1, fontSize: 13, ...k.input }}
              placeholder="Что происходит?"
              aria-label="Опишите ситуацию"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
              disabled={loading}
            />
            <button
              type="button"
              className="ds-btn ds-btn-primary"
              style={{ padding: '8px 12px' }}
              onClick={() => void send()}
              disabled={loading || !input.trim()}
              aria-label="Отправить"
            >
              <Send size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
