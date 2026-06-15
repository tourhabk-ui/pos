'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Activity, Flame, Wind, Thermometer, Droplets, RefreshCw, Bot, Send, ChevronDown, ChevronUp, Phone } from 'lucide-react';

// ── Типы ──────────────────────────────────────────────────────────

interface ZoneData {
  zone: string;
  zone_name: string;
  risk_score: number;
  risk_level: string;
  recommended_action: string;
  analysis_text: string | null;
  threat_types: string[];
  updated_at: string;
}

interface SeismicEvent {
  id: string;
  magnitude: number;
  place: string;
  time: number;
  depth: number;
}

interface VolcanicEvent {
  id: string;
  title: string;
  description: string | null;
  severity: number;
  affected_zones: string[];
  created_at: string;
}

interface WeatherData {
  tempC: string;
  feelsLikeC: string;
  desc: string;
  humidity: string;
  windKmph: string;
}

interface RescueMsg {
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
}

// ── Вспомогательное ───────────────────────────────────────────────

const RISK_COLORS: Record<string, string> = {
  low:      'var(--success)',
  moderate: 'var(--warning)',
  high:     'var(--accent)',
  critical: 'var(--danger)',
};

const RISK_LABELS: Record<string, string> = {
  low:      'Норма',
  moderate: 'Повышенная',
  high:     'Высокая',
  critical: 'Критическая',
};

const ACTION_LABELS: Record<string, string> = {
  NORMAL:                 '',
  WATCH:                  'Наблюдение',
  EVACUATE_PRIORITY_2:    'Эвакуация (P2)',
  EVACUATE_IMMEDIATE:     'Немедленная эвакуация',
};

function magColor(mag: number): string {
  if (mag >= 5.5) return 'var(--danger)';
  if (mag >= 4.0) return 'var(--warning)';
  return 'var(--text-secondary)';
}

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h > 0) return `${h} ч назад`;
  if (m > 0) return `${m} мин назад`;
  return 'только что';
}

const LOCAL_PROTOCOLS: [RegExp, string][] = [
  [/медвед|bear/i,        '1. Не беги\n2. Говори громко и спокойно\n3. Стань визуально больше\n4. Медленно отступай не поворачивайся спиной\n5. Атака — упади, притворись мёртвым, защити шею\n\nПозвоните: 112'],
  [/заблуд|потеря|lost/i, '1. СТОП — экономь силы\n2. Оставайся на месте\n3. 3 свистка = сигнал бедствия\n4. На возвышенность для связи\n5. Ищи ручей — выведет к людям\n\nПозвоните: 112'],
  [/трав|кров|перелом/i,  '1. Остановите кровь — прямое давление\n2. Жгут выше раны (запишите время!)\n3. Перелом: иммобилизуйте подручным\n4. Позвоночник: НЕ двигать\n\nПозвоните: 112'],
  [/холод|замёрз|гипотерм/i, '1. Снять мокрое, укрыться от ветра\n2. Горячее сладкое питьё (не алкоголь)\n3. В горизонтальное положение\n4. Не давать заснуть\n\nПозвоните: 112'],
  [/земл|тряс|quake/i,   '1. Внутри: под стол/в проём, защитить голову\n2. Снаружи: от зданий/деревьев/ЛЭП, лечь\n3. Цунами-угроза: немедленно на возвышение\n\nПозвоните: 112'],
  [/вулкан|пепел|volcano/i, '1. Уйти перпендикулярно ветру\n2. Защитить дыхание влажной тканью\n3. Пирокластический поток: лечь в яму/канаву\n\nПозвоните: 112'],
];

function getLocalProtocol(text: string): string | null {
  for (const [pattern, response] of LOCAL_PROTOCOLS) {
    if (pattern.test(text)) return response;
  }
  return null;
}

const EMERGENCY_CONTACTS = [
  { name: 'Спасение / полиция / скорая', number: '112' },
  { name: 'МЧС Камчатки', number: '8 (4152) 29-99-99' },
  { name: 'ПАСС (поиск и спасение)', number: '8 (4152) 41-03-03' },
];

// ── Компонент ─────────────────────────────────────────────────────

export default function SafetyClient() {
  const [zones, setZones] = useState<ZoneData[]>([]);
  const [seismic, setSeismic] = useState<SeismicEvent[]>([]);
  const [volcanic, setVolcanic] = useState<VolcanicEvent[]>([]);
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [loading, setLoading] = useState(true);

  const [seismicOpen, setSeismicOpen] = useState(false);
  const [volcanicOpen, setVolcanicOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState<RescueMsg[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void Promise.all([
      fetch('/api/public/danger-summary').then(r => r.json()).then((d: { zones?: ZoneData[] }) => setZones(d.zones ?? [])).catch(() => {}),
      fetch('/api/safety/seismic').then(r => r.json()).then((d: { events?: SeismicEvent[] }) => setSeismic(d.events ?? [])).catch(() => {}),
      fetch('/api/safety/volcanic').then(r => r.json()).then((d: { events?: VolcanicEvent[] }) => setVolcanic(d.events ?? [])).catch(() => {}),
      fetch('/api/safety/weather').then(r => r.json()).then((d: WeatherData) => setWeather(d.tempC ? d : null)).catch(() => {}),
    ]).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (chatOpen) chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages, chatOpen]);

  const maxRisk = zones.reduce((max, z) => {
    const order = ['low', 'moderate', 'high', 'critical'];
    return order.indexOf(z.risk_level) > order.indexOf(max) ? z.risk_level : max;
  }, 'low');

  const sendRescueMessage = useCallback(async () => {
    const text = chatInput.trim();
    if (!text || chatLoading) return;
    setChatInput('');
    const userMsg: RescueMsg = { role: 'user', content: text };
    setChatMessages(prev => [...prev, userMsg]);
    setChatLoading(true);

    const local = getLocalProtocol(text);
    if (local || !navigator.onLine) {
      const reply = local ?? 'Нет связи. Позвоните 112. Оставайтесь на месте.';
      setChatMessages(prev => [...prev, { role: 'assistant', content: reply }]);
      setChatLoading(false);
      return;
    }

    try {
      const history = chatMessages.map(m => ({ role: m.role, content: m.content }));
      const res = await fetch('/api/safety/rescue-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history, stream: true }),
      });
      if (!res.ok || !res.body) throw new Error('no stream');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let assistantContent = '';
      setChatMessages(prev => [...prev, { role: 'assistant', content: '', streaming: true }]);
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
            assistantContent += parsed.choices?.[0]?.delta?.content ?? '';
            setChatMessages(prev => {
              const next = [...prev];
              next[next.length - 1] = { role: 'assistant', content: assistantContent, streaming: true };
              return next;
            });
          } catch { /* ignore parse errors */ }
        }
      }
      setChatMessages(prev => {
        const next = [...prev];
        next[next.length - 1] = { role: 'assistant', content: assistantContent, streaming: false };
        return next;
      });
    } catch {
      setChatMessages(prev => [...prev, { role: 'assistant', content: 'Ошибка связи. В экстренной ситуации звоните 112.' }]);
    } finally {
      setChatLoading(false);
    }
  }, [chatInput, chatLoading, chatMessages]);

  const bannerColor = RISK_COLORS[maxRisk] ?? 'var(--success)';
  const bannerLabel = maxRisk === 'low' ? 'Обстановка нормальная' : `Опасность: ${RISK_LABELS[maxRisk]}`;

  return (
    <div className="ds-page" style={{ maxWidth: 680, margin: '0 auto' }}>
      {/* Заголовок */}
      <div style={{ marginBottom: 24 }}>
        <p style={{ color: 'var(--text-secondary)', fontSize: 12, marginBottom: 4 }}>Камчатка · обновляется автоматически</p>
        <h1 className="ds-h1" style={{ marginBottom: 8 }}>Безопасность</h1>
      </div>

      {/* Баннер статуса */}
      {!loading && (
        <div style={{
          background: `color-mix(in srgb, ${bannerColor} 12%, var(--bg-card))`,
          border: `1px solid color-mix(in srgb, ${bannerColor} 30%, transparent)`,
          borderRadius: 10,
          padding: '12px 16px',
          marginBottom: 20,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: bannerColor, flexShrink: 0 }} />
          <span style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: 14 }}>{bannerLabel}</span>
        </div>
      )}

      {/* Зоны */}
      {loading ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 20 }}>
          {[0,1,2,3].map(i => <div key={i} className="ds-skeleton" style={{ height: 80, borderRadius: 10 }} />)}
        </div>
      ) : zones.length > 0 ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 20 }}>
          {zones.map(z => {
            const color = RISK_COLORS[z.risk_level] ?? 'var(--text-secondary)';
            const action = ACTION_LABELS[z.recommended_action];
            return (
              <div key={z.zone} className="ds-card" style={{ padding: '12px 14px' }}>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>{z.zone_name}</div>
                <div style={{ fontSize: 18, fontWeight: 700, color, marginBottom: 2 }}>{z.risk_score}</div>
                <div style={{ fontSize: 11, color }}>{RISK_LABELS[z.risk_level] ?? z.risk_level}</div>
                {action && <div style={{ fontSize: 10, color: 'var(--warning)', marginTop: 4 }}>{action}</div>}
              </div>
            );
          })}
        </div>
      ) : null}

      {/* Сейсмика */}
      <div className="ds-card" style={{ marginBottom: 12, overflow: 'hidden' }}>
        <button
          onClick={() => setSeismicOpen(o => !o)}
          style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', background: 'none', border: 'none', cursor: 'pointer' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Activity size={16} color="var(--ocean)" />
            <span style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: 14 }}>Сейсмика</span>
            {seismic.length > 0 && (
              <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{seismic.length} событий (USGS)</span>
            )}
          </div>
          {seismicOpen ? <ChevronUp size={15} color="var(--text-secondary)" /> : <ChevronDown size={15} color="var(--text-secondary)" />}
        </button>
        {seismicOpen && (
          <div style={{ borderTop: '1px solid var(--border)' }}>
            {seismic.length === 0 ? (
              <p style={{ padding: '12px 16px', color: 'var(--text-secondary)', fontSize: 13 }}>Нет событий M2.5+ за последние сутки.</p>
            ) : (
              seismic.map(ev => (
                <div key={ev.id} style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                  <div>
                    <span style={{ fontWeight: 700, color: magColor(ev.magnitude), fontSize: 15 }}>M{ev.magnitude.toFixed(1)}</span>
                    <span style={{ color: 'var(--text-secondary)', fontSize: 12, marginLeft: 8 }}>{ev.depth} км глубина</span>
                    <p style={{ margin: '2px 0 0', color: 'var(--text-primary)', fontSize: 12 }}>{ev.place}</p>
                  </div>
                  <span style={{ color: 'var(--text-muted)', fontSize: 11, whiteSpace: 'nowrap' }}>{timeAgo(ev.time)}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Вулканы */}
      <div className="ds-card" style={{ marginBottom: 12, overflow: 'hidden' }}>
        <button
          onClick={() => setVolcanicOpen(o => !o)}
          style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', background: 'none', border: 'none', cursor: 'pointer' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Flame size={16} color="var(--accent)" />
            <span style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: 14 }}>Вулканическая активность</span>
            {volcanic.length > 0 && (
              <span style={{ fontSize: 11, background: 'color-mix(in srgb, var(--accent) 15%, transparent)', color: 'var(--accent)', padding: '2px 6px', borderRadius: 10 }}>{volcanic.length}</span>
            )}
          </div>
          {volcanicOpen ? <ChevronUp size={15} color="var(--text-secondary)" /> : <ChevronDown size={15} color="var(--text-secondary)" />}
        </button>
        {volcanicOpen && (
          <div style={{ borderTop: '1px solid var(--border)' }}>
            {volcanic.length === 0 ? (
              <p style={{ padding: '12px 16px', color: 'var(--text-secondary)', fontSize: 13 }}>Активных вулканических предупреждений нет.</p>
            ) : (
              volcanic.map(ev => {
                const sevColor = ev.severity >= 3 ? 'var(--danger)' : ev.severity === 2 ? 'var(--warning)' : 'var(--text-secondary)';
                return (
                  <div key={ev.id} style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                      <span style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: 13 }}>{ev.title}</span>
                      <span style={{ fontSize: 11, color: sevColor }}>Уровень {ev.severity}</span>
                    </div>
                    {ev.description && <p style={{ color: 'var(--text-secondary)', fontSize: 12, margin: 0 }}>{ev.description}</p>}
                    {ev.affected_zones.length > 0 && (
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
                        {ev.affected_zones.map(z => (
                          <span key={z} style={{ fontSize: 10, padding: '2px 6px', background: 'var(--bg-hover)', color: 'var(--text-secondary)', borderRadius: 6 }}>{z}</span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* Погода */}
      {weather && (
        <div className="ds-card" style={{ padding: '14px 16px', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 16 }}>
          <Thermometer size={16} color="var(--ocean)" />
          <div>
            <span style={{ fontWeight: 700, fontSize: 18, color: 'var(--text-primary)' }}>{weather.tempC}°C</span>
            <span style={{ color: 'var(--text-secondary)', fontSize: 12, marginLeft: 8 }}>{weather.desc}</span>
          </div>
          <div style={{ display: 'flex', gap: 12, marginLeft: 'auto' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--text-secondary)', fontSize: 12 }}>
              <Wind size={12} />{weather.windKmph} км/ч
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--text-secondary)', fontSize: 12 }}>
              <Droplets size={12} />{weather.humidity}%
            </span>
          </div>
        </div>
      )}

      {/* Экстренные контакты */}
      <div className="ds-card" style={{ padding: '14px 16px', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <Phone size={14} color="var(--danger)" />
          <span style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: 13 }}>Экстренные контакты</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {EMERGENCY_CONTACTS.map(c => (
            <div key={c.number} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{c.name}</span>
              <a href={`tel:${c.number.replace(/\s/g, '')}`} style={{ fontWeight: 700, color: 'var(--danger)', fontSize: 13, textDecoration: 'none' }}>{c.number}</a>
            </div>
          ))}
        </div>
      </div>

      {/* AI Спасатель */}
      <div className="ds-card" style={{ overflow: 'hidden', marginBottom: 32 }}>
        <button
          onClick={() => setChatOpen(o => !o)}
          style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', background: 'none', border: 'none', cursor: 'pointer' }}
        >
          <Bot size={16} color="var(--ocean)" />
          <div style={{ textAlign: 'left' }}>
            <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: 14 }}>AI Спасатель</div>
            <div style={{ color: 'var(--text-secondary)', fontSize: 11 }}>Экстренные протоколы · работает офлайн</div>
          </div>
          <span style={{ marginLeft: 'auto', color: 'var(--text-secondary)' }}>
            {chatOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </span>
        </button>

        {chatOpen && (
          <div style={{ borderTop: '1px solid var(--border)' }}>
            <div style={{ height: 240, overflowY: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {chatMessages.length === 0 && (
                <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: 0 }}>Опишите ситуацию: медведь, травма, потеря, гипотермия, землетрясение...</p>
              )}
              {chatMessages.map((m, i) => (
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
              <div ref={chatEndRef} />
            </div>
            <div style={{ borderTop: '1px solid var(--border)', display: 'flex', gap: 8, padding: '10px 12px' }}>
              <input
                className="ds-input"
                style={{ flex: 1, fontSize: 13 }}
                placeholder="Что происходит?"
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendRescueMessage(); } }}
                disabled={chatLoading}
              />
              <button
                className="ds-btn ds-btn-primary"
                style={{ padding: '8px 12px' }}
                onClick={() => void sendRescueMessage()}
                disabled={chatLoading || !chatInput.trim()}
              >
                <Send size={14} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
