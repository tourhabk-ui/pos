'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import {
  Download, Trash2, Route, AlertTriangle, ChevronDown, ChevronUp,
  Phone, MapPin, Shield, Clock, Mountain, Loader, CheckCircle,
  CloudOff, Wifi, Share2, Copy, Check, MessageSquare, Send, X,
} from 'lucide-react';
import { useTripPack } from '@/lib/offline/useTripPack';
import type { OfflineTripPlan } from '@/lib/offline/db';

// ─── Itinerary types ──────────────────────────────────────────────────────────

interface ItineraryDay {
  day: number;
  title: string;
  distanceKm?: number;
  elevationGain?: number;
  estimatedHours?: number;
  notes: string;
  hazards?: string[];
  checkpoints?: string[];
  camp?: string;
}

interface Itinerary {
  title?: string;
  summary?: string;
  days?: ItineraryDay[];
  equipment?: string[];
  warnings?: string[];
  bestTime?: string;
  mchsNote?: string;
  raw?: string;
}

function parseItinerary(raw: unknown): Itinerary {
  if (typeof raw === 'object' && raw !== null) return raw as Itinerary;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as Itinerary; } catch { return { raw }; }
  }
  return {};
}

// ─── Day card ─────────────────────────────────────────────────────────────────

function DayCard({ day }: { day: ItineraryDay }) {
  const [open, setOpen] = useState(day.day === 1);

  return (
    <div className="ds-card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between p-4 hover:bg-[var(--bg-hover)] transition-colors"
      >
        <div className="flex items-center gap-3 text-left">
          <span className="w-8 h-8 rounded-full bg-[var(--accent)] text-white text-sm font-bold flex items-center justify-center shrink-0">
            {day.day}
          </span>
          <div>
            <p className="font-medium text-[var(--text-primary)] text-sm">{day.title}</p>
            <div className="flex gap-3 text-xs text-[var(--text-muted)] mt-0.5">
              {day.distanceKm     && <span>{day.distanceKm} км</span>}
              {day.estimatedHours && <span><Clock className="inline w-3 h-3" /> {day.estimatedHours} ч</span>}
              {day.elevationGain  && <span><Mountain className="inline w-3 h-3" /> +{day.elevationGain} м</span>}
            </div>
          </div>
        </div>
        {open
          ? <ChevronUp   className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
          : <ChevronDown className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
        }
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-3 border-t border-[var(--border)]">
          <p className="text-sm text-[var(--text-secondary)] mt-3 leading-relaxed">{day.notes}</p>

          {day.checkpoints && day.checkpoints.length > 0 && (
            <div>
              <p className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide mb-1.5">Контрольные точки</p>
              <ol className="space-y-1">
                {day.checkpoints.map((cp, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-[var(--text-secondary)]">
                    <MapPin className="w-3.5 h-3.5 text-[var(--ocean)] shrink-0 mt-0.5" />
                    {cp}
                  </li>
                ))}
              </ol>
            </div>
          )}

          {day.hazards && day.hazards.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {day.hazards.map(h => (
                <span key={h} className="ds-badge text-xs flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3 text-[var(--warning)]" />
                  {h}
                </span>
              ))}
            </div>
          )}

          {day.camp && (
            <p className="text-xs text-[var(--text-muted)] flex items-center gap-1.5 pt-1 border-t border-[var(--border)]">
              <CheckCircle className="w-3.5 h-3.5 text-[var(--success)]" />
              Ночёвка: {day.camp}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Chat refinement panel ────────────────────────────────────────────────────

interface ChatMessage { role: 'user' | 'assistant'; text: string }

function RefinementPanel({
  planId, routeTitle, itinerary, onUpdated,
}: {
  planId: string;
  routeTitle: string;
  itinerary: Itinerary;
  onUpdated: (newItinerary: Itinerary) => void;
}) {
  const [open, setOpen]       = useState(false);
  const [input, setInput]     = useState('');
  const [sending, setSending] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: 'assistant', text: 'Хочешь что-то поменять в плане? Напиши — например: «сделай легче День 2», «добавь термальные источники», «что если пойдёт дождь».' },
  ]);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    setMessages(m => [...m, { role: 'user', text }]);
    setSending(true);

    try {
      const res = await fetch(`/api/trip-plans/${planId}/refine`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, currentItinerary: itinerary, routeTitle }),
      });
      const json = await res.json() as { success: boolean; reply: string; itinerary?: Itinerary };
      if (json.success) {
        setMessages(m => [...m, { role: 'assistant', text: json.reply }]);
        if (json.itinerary) onUpdated(json.itinerary);
      } else {
        setMessages(m => [...m, { role: 'assistant', text: 'Не удалось обработать запрос, попробуйте ещё раз.' }]);
      }
    } catch {
      setMessages(m => [...m, { role: 'assistant', text: 'Ошибка сети. Проверьте подключение.' }]);
    } finally {
      setSending(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="ds-card p-4 w-full flex items-center gap-3 hover:bg-[var(--bg-hover)] transition-colors text-left"
      >
        <MessageSquare className="w-5 h-5 text-[var(--ocean)] shrink-0" />
        <div>
          <p className="text-sm font-medium text-[var(--text-primary)]">Изменить план</p>
          <p className="text-xs text-[var(--text-muted)]">«Сделай легче», «добавь термальные», «что при дожде»</p>
        </div>
      </button>
    );
  }

  return (
    <div className="ds-card overflow-hidden">
      <div className="flex items-center justify-between p-4 border-b border-[var(--border)]">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-[var(--ocean)]" />
          <span className="text-sm font-medium text-[var(--text-primary)]">Изменить план</span>
        </div>
        <button type="button" onClick={() => setOpen(false)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="h-56 overflow-y-auto p-4 space-y-3">
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={[
              'max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed',
              m.role === 'user'
                ? 'bg-[var(--accent)] text-white rounded-br-sm'
                : 'bg-[var(--bg-hover)] text-[var(--text-primary)] rounded-bl-sm',
            ].join(' ')}>
              {m.text}
            </div>
          </div>
        ))}
        {sending && (
          <div className="flex justify-start">
            <div className="bg-[var(--bg-hover)] rounded-2xl rounded-bl-sm px-3 py-2">
              <Loader className="w-4 h-4 animate-spin text-[var(--text-muted)]" />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="p-3 border-t border-[var(--border)] flex gap-2">
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && !e.shiftKey && send()}
          placeholder="Сделай День 1 короче..."
          className="ds-input flex-1 text-sm"
          disabled={sending}
        />
        <button
          type="button"
          onClick={send}
          disabled={!input.trim() || sending}
          className="ds-btn ds-btn-primary px-3 disabled:opacity-50"
        >
          <Send className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

// ─── Share button ─────────────────────────────────────────────────────────────

function ShareButton({ planId }: { planId: string }) {
  const [copied, setCopied] = useState(false);

  async function handleShare() {
    const url = `${window.location.origin}/trips/${planId}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Мой маршрут по Камчатке', url });
        return;
      } catch { /* fall through to clipboard */ }
    }
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button
      type="button"
      onClick={handleShare}
      className="ds-btn ds-btn-secondary text-sm flex items-center gap-1.5"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-[var(--success)]" /> : <Share2 className="w-3.5 h-3.5" />}
      {copied ? 'Скопировано' : 'Поделиться'}
    </button>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function TripViewClient({ planId }: { planId: string }) {
  const { status, error, plan, checkCached, download, remove } = useTripPack(planId);
  const [onlineData, setOnlineData] = useState<OfflineTripPlan | null>(null);
  const [isOnline, setIsOnline]     = useState(true);
  const [liveItinerary, setLiveItinerary] = useState<Itinerary | null>(null);

  useEffect(() => {
    setIsOnline(navigator.onLine);
    const onOn  = () => setIsOnline(true);
    const onOff = () => setIsOnline(false);
    window.addEventListener('online',  onOn);
    window.addEventListener('offline', onOff);
    return () => { window.removeEventListener('online', onOn); window.removeEventListener('offline', onOff); };
  }, []);

  const fetchOnline = useCallback(() => {
    if (typeof navigator !== 'undefined' && navigator.onLine) {
      fetch(`/api/trip-plans/${planId}/pack`)
        .then(r => r.ok ? r.json() : null)
        .then((j: { success: boolean; data: OfflineTripPlan } | null) => {
          if (j?.success) setOnlineData(j.data);
        })
        .catch(() => null);
    }
  }, [planId]);

  useEffect(() => {
    checkCached();
    fetchOnline();
  }, [planId, checkCached, fetchOnline]);

  const displayPlan = plan ?? onlineData;

  if (!displayPlan && status !== 'error') {
    return (
      <div className="ds-page flex items-center justify-center min-h-[60vh]">
        <Loader className="w-8 h-8 animate-spin text-[var(--accent)]" />
      </div>
    );
  }

  if (!displayPlan && status === 'error') {
    return (
      <div className="ds-page flex items-center justify-center min-h-[60vh]">
        <div className="text-center space-y-3">
          <AlertTriangle className="w-8 h-8 text-[var(--danger)] mx-auto" />
          <p className="text-[var(--text-secondary)]">План не найден</p>
          <p className="text-xs text-[var(--text-muted)]">{error}</p>
        </div>
      </div>
    );
  }

  const itin  = liveItinerary ?? parseItinerary(displayPlan!.itinerary);
  const ddays: ItineraryDay[] = itin.days ?? [];

  return (
    <div className="ds-page">
      <div className="ds-section max-w-2xl mx-auto space-y-6">

        {/* Offline/Online badge */}
        <div className={[
          'flex items-center gap-2 text-xs px-3 py-1.5 rounded-full w-fit',
          isOnline
            ? 'bg-[var(--bg-hover)] text-[var(--text-muted)]'
            : 'bg-[var(--danger)] text-white',
        ].join(' ')}>
          {isOnline
            ? <><Wifi className="w-3.5 h-3.5" /> Онлайн</>
            : <><CloudOff className="w-3.5 h-3.5" /> Офлайн — план работает</>
          }
        </div>

        {/* Header */}
        <div>
          <div className="flex items-center gap-2 text-[var(--text-muted)] text-xs mb-1">
            <Route className="w-3.5 h-3.5" />
            <span>
              {displayPlan!.route.zone ?? 'Камчатка'} · {displayPlan!.days}{' '}
              {displayPlan!.days === 1 ? 'день' : displayPlan!.days < 5 ? 'дня' : 'дней'}
            </span>
          </div>
          <h1 className="ds-h1 text-2xl">{displayPlan!.title}</h1>
          {itin.summary && (
            <p className="text-[var(--text-secondary)] text-sm mt-2 leading-relaxed">{itin.summary}</p>
          )}
        </div>

        {/* Action bar: Download + Share */}
        <div className="ds-card p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm">
            {status === 'cached'
              ? <span className="flex items-center gap-1.5 text-[var(--success)]"><CheckCircle className="w-4 h-4" /> Сохранён офлайн</span>
              : <span className="text-[var(--text-secondary)]">Не сохранён офлайн</span>
            }
          </div>
          <div className="flex gap-2 flex-wrap">
            <ShareButton planId={planId} />
            {status !== 'cached' && (
              <button
                onClick={download}
                disabled={status === 'downloading'}
                className="ds-btn ds-btn-primary text-sm flex items-center gap-1.5 disabled:opacity-50"
              >
                {status === 'downloading'
                  ? <Loader className="w-3.5 h-3.5 animate-spin" />
                  : <Download className="w-3.5 h-3.5" />
                }
                Скачать офлайн
              </button>
            )}
            {status === 'cached' && (
              <button onClick={remove} className="ds-btn ds-btn-secondary text-sm flex items-center gap-1.5">
                <Trash2 className="w-3.5 h-3.5" />
                Удалить
              </button>
            )}
          </div>
        </div>

        {/* Route stats */}
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: 'Расстояние',   value: displayPlan!.route.distanceKm    ? `${displayPlan!.route.distanceKm} км`    : '—' },
            { label: 'Набор высоты', value: displayPlan!.route.elevationGainM ? `${displayPlan!.route.elevationGainM} м` : '—' },
            { label: 'Сложность',    value: displayPlan!.route.difficulty     ?? '—' },
          ].map(s => (
            <div key={s.label} className="ds-card p-3 text-center">
              <p className="text-[var(--text-primary)] font-medium text-sm">{s.value}</p>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">{s.label}</p>
            </div>
          ))}
        </div>

        {/* MChS + warnings */}
        {(itin.warnings?.length || displayPlan!.route.mchsRequired) && (
          <div className="space-y-2">
            {displayPlan!.route.mchsRequired && (
              <div className="ds-card p-4 border-l-4 border-[var(--warning)] flex gap-3">
                <Shield className="w-5 h-5 text-[var(--warning)] shrink-0" />
                <div>
                  <p className="text-sm font-medium text-[var(--text-primary)]">Регистрация в МЧС обязательна</p>
                  {displayPlan!.route.mchsPhone && (
                    <p className="text-xs text-[var(--text-muted)] mt-0.5">{displayPlan!.route.mchsPhone}</p>
                  )}
                </div>
              </div>
            )}
            {itin.warnings?.map(w => (
              <div key={w} className="ds-card p-3 flex gap-2">
                <AlertTriangle className="w-4 h-4 text-[var(--warning)] shrink-0 mt-0.5" />
                <p className="text-sm text-[var(--text-secondary)]">{w}</p>
              </div>
            ))}
          </div>
        )}

        {/* Days */}
        {ddays.length > 0 && (
          <div>
            <h2 className="ds-h2 text-lg mb-3">По дням</h2>
            <div className="space-y-3">
              {ddays.map(d => <DayCard key={d.day} day={d} />)}
            </div>
          </div>
        )}

        {/* Chat refinement — only online */}
        {isOnline && (
          <RefinementPanel
            planId={planId}
            routeTitle={displayPlan!.route.title}
            itinerary={itin}
            onUpdated={setLiveItinerary}
          />
        )}

        {/* Equipment */}
        {(itin.equipment?.length || displayPlan!.route.equipment.length > 0) && (
          <div className="ds-card p-4">
            <h2 className="text-sm font-medium text-[var(--text-primary)] mb-3">Снаряжение</h2>
            <div className="flex flex-wrap gap-2">
              {(itin.equipment ?? displayPlan!.route.equipment).map(e => (
                <span key={e} className="ds-badge text-xs">{e}</span>
              ))}
            </div>
          </div>
        )}

        {/* SOS contacts */}
        <div>
          <h2 className="ds-h2 text-lg mb-3">Экстренные контакты</h2>
          <div className="space-y-2">
            {displayPlan!.sosContacts.map(c => (
              <a
                key={c.id}
                href={`tel:${c.phone.replace(/\s/g, '')}`}
                className="ds-card p-3 flex items-center gap-3 hover:bg-[var(--bg-hover)] transition-colors"
              >
                <Phone className="w-4 h-4 text-[var(--danger)] shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-[var(--text-primary)] truncate">{c.name}</p>
                  <p className="text-xs text-[var(--text-muted)]">{c.phone}</p>
                </div>
              </a>
            ))}
          </div>
        </div>

        {/* Waypoints */}
        {displayPlan!.waypoints.length > 0 && (
          <div>
            <h2 className="ds-h2 text-lg mb-3">Точки маршрута</h2>
            <div className="space-y-2">
              {displayPlan!.waypoints.map(w => (
                <div key={w.placeId} className="ds-card p-3 flex gap-3">
                  <span className="w-6 h-6 rounded-full bg-[var(--ocean)] text-white text-xs flex items-center justify-center shrink-0 font-medium">
                    {w.position + 1}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-[var(--text-primary)]">{w.name}</p>
                    <div className="flex flex-wrap gap-2 mt-0.5 text-xs text-[var(--text-muted)]">
                      {w.altitudeM    && <span>{w.altitudeM} м</span>}
                      {w.locationType && <span>{w.locationType}</span>}
                      {w.isOpen === false && <span className="text-[var(--danger)]">Закрыто</span>}
                    </div>
                    {w.hazardTypes.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {w.hazardTypes.map(h => (
                          <span key={h} className="ds-badge text-xs flex items-center gap-1">
                            <AlertTriangle className="w-2.5 h-2.5 text-[var(--warning)]" />
                            {h}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
