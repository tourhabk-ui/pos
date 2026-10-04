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

export default function RescueChat({ className, style }: { className?: string; style?: React.CSSProperties }) {
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
    <div className={`ds-card ${className ?? ''}`} style={{ overflow: 'hidden', ...style }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', background: 'none', border: 'none', cursor: 'pointer' }}
      >
        <Bot size={16} color="var(--ocean)" />
        <div style={{ textAlign: 'left' }}>
          <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: 14 }}>AI Спасатель</div>
          <div style={{ color: 'var(--text-secondary)', fontSize: 11 }}>Экстренные протоколы · работает офлайн</div>
        </div>
        <span style={{ marginLeft: 'auto', color: 'var(--text-secondary)' }}>
          {open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </span>
      </button>

      {open && (
        <div style={{ borderTop: '1px solid var(--border)' }}>
          <div style={{ height: 240, overflowY: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {messages.length === 0 && (
              <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: 0 }}>Опишите ситуацию: медведь, травма, потеря, гипотермия, землетрясение...</p>
            )}
            {messages.map((m, i) => (
              <div key={i} style={{
                alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '85%',
                background: m.role === 'user' ? 'var(--ocean)' : 'var(--bg-hover)',
                color: m.role === 'user' ? '#fff' : 'var(--text-primary)',
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
          <div style={{ borderTop: '1px solid var(--border)', display: 'flex', gap: 8, padding: '10px 12px' }}>
            <input
              className="ds-input"
              style={{ flex: 1, fontSize: 13 }}
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
