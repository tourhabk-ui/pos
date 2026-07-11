'use client';

import { useState, useRef, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  Bot, Send, Loader2, User, Sun, Moon, MapPin, ChevronRight,
  Mic, MicOff, Star, Clock, Ruler, AlertTriangle,
  Car, Bookmark, RefreshCw,
} from 'lucide-react';
import Logo from '@/components/shared/Logo';
import { useTheme } from '@/contexts/ThemeContext';
import BottomNav from '@/components/shared/BottomNav';
import Link from 'next/link';
import Image from 'next/image';

interface TourSuggestion {
  id: number;
  title: string;
  description: string | null;
  base_price: number;
  activity_type: string | null;
  location: string | null;
  tour_image: string | null;
  operator_name: string;
}

interface RouteRec {
  id: string;
  title: string;
  difficulty?: string | null;
  durationHours?: number | null;
  distanceKm?: number | null;
  rating?: number | null;
  imageUrl?: string | null;
  fromLocation?: string | null;
  fromMinutes?: number | null;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  tours?: TourSuggestion[];
  routes?: RouteRec[];
  warning?: string | null;
  /** Запрос пользователя для фолбэк-ссылки в каталог, когда AI недоступен. */
  searchFallback?: string;
}

// Фолбэк-ответы AI-конвейера: чат не смог — даём человеку прямой путь в каталог.
const AI_ERROR_PREFIXES = ['Извините, сервис временно недоступен', 'Сервис временно недоступен', 'Извините, не удалось получить ответ', 'Сервер недоступен'];
const isAiErrorReply = (text: string) => AI_ERROR_PREFIXES.some(p => text.startsWith(p));

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isTourSuggestion(v: unknown): v is TourSuggestion {
  return isRecord(v) && typeof v.id === 'number' && typeof v.title === 'string';
}

function isRouteRec(v: unknown): v is RouteRec {
  return isRecord(v) && typeof v.id === 'string' && typeof v.title === 'string';
}

function formatPrice(p: number): string {
  return new Intl.NumberFormat('ru-RU').format(p) + ' ₽';
}

const DIFFICULTY_LABELS: Record<string, string> = {
  easy: 'Лёгкий',
  medium: 'Средний',
  hard: 'Сложный',
  extreme: 'Экстремальный',
};

function RouteCard({ route }: { route: RouteRec }) {
  return (
    <Link
      href={`/routes/${route.id}`}
      className="block rounded-xl overflow-hidden border border-[var(--border)] bg-[var(--bg-card)] hover:border-[var(--accent)]/40 transition-all"
    >
      <div className="relative h-36 bg-[var(--bg-hover)]">
        {route.imageUrl ? (
          <Image
            src={route.imageUrl}
            alt={route.title}
            fill
            sizes="(max-width: 600px) 100vw, 480px"
            className="object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <MapPin className="w-8 h-8 text-[var(--text-muted)]" />
          </div>
        )}
      </div>
      <div className="p-3">
        <h4 className="font-semibold text-sm text-[var(--text-primary)] mb-1">{route.title}</h4>
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-[var(--text-secondary)] mb-1.5">
          {route.difficulty && (
            <span>{DIFFICULTY_LABELS[route.difficulty] ?? route.difficulty}</span>
          )}
          {route.durationHours && (
            <>
              {route.difficulty && <span>•</span>}
              <span className="flex items-center gap-0.5">
                <Clock className="w-3 h-3" />{route.durationHours} ч
              </span>
            </>
          )}
          {route.distanceKm && (
            <>
              <span>•</span>
              <span className="flex items-center gap-0.5">
                <Ruler className="w-3 h-3" />{route.distanceKm} км
              </span>
            </>
          )}
        </div>
        {route.fromLocation && route.fromMinutes && (
          <p className="text-xs text-[var(--text-muted)] mb-2">
            От {route.fromLocation}: {route.fromMinutes} мин на авто
          </p>
        )}
        <div className="flex items-center justify-between">
          {route.rating ? (
            <div className="flex items-center gap-1 text-xs" style={{ color: 'var(--warning)' }}>
              <Star className="w-3 h-3 fill-current" />
              {route.rating.toFixed(1)}
            </div>
          ) : <span />}
          <span className="text-xs font-medium text-[var(--accent)]">Подробнее →</span>
        </div>
      </div>
    </Link>
  );
}

function WarningCard({ text }: { text: string }) {
  return (
    <div
      className="flex items-start gap-2 p-3 rounded-lg border text-sm"
      style={{
        background: 'color-mix(in srgb, var(--warning) 10%, var(--bg-card))',
        borderColor: 'color-mix(in srgb, var(--warning) 30%, transparent)',
        color: 'var(--text-primary)',
      }}
    >
      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--warning)' }} />
      <p>{text}</p>
    </div>
  );
}

function TourCard({ tour }: { tour: TourSuggestion }) {
  return (
    <Link
      href={`/marketplace/tours/${tour.id}`}
      className="group flex items-start gap-3 p-3 rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] hover:border-[var(--accent)]/40 hover:bg-[var(--bg-hover)] transition-all"
    >
      <div className="relative w-16 h-16 rounded-md overflow-hidden shrink-0 bg-[var(--bg-hover)]">
        {tour.tour_image ? (
          <Image src={tour.tour_image} alt={tour.title} fill sizes="64px" className="object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <MapPin className="w-5 h-5 text-[var(--text-muted)]" />
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-[var(--text-primary)] truncate">{tour.title}</p>
        <p className="text-xs text-[var(--text-secondary)] truncate">{tour.operator_name}</p>
        {tour.description && (
          <p className="text-xs text-[var(--text-muted)] mt-0.5 line-clamp-2">{tour.description}</p>
        )}
        <p className="text-xs font-medium text-[var(--accent)] mt-1">от {formatPrice(tour.base_price)}</p>
      </div>
      <ChevronRight className="w-4 h-4 text-[var(--text-muted)] group-hover:text-[var(--accent)] shrink-0 mt-1 transition-colors" />
    </Link>
  );
}

function AIAssistantContent({ initialQuery }: { initialQuery: string | null }) {
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const raw = localStorage.getItem('th_ai_chat_history');
      return raw ? (JSON.parse(raw) as ChatMessage[]) : [];
    } catch { return []; }
  });
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [listening, setListening] = useState(false);
  const [isOffline, setIsOffline] = useState(false);
  const [sessionId] = useState(() => {
    if (typeof window === 'undefined') return '';
    const key = 'th_ai_assistant_session';
    let id = localStorage.getItem(key);
    if (!id) { id = crypto.randomUUID(); localStorage.setItem(key, id); }
    return id;
  });
  const [limitReached, setLimitReached] = useState(false);
  const [remainingFree, setRemainingFree] = useState<number | null>(null);
  const [routeSaveState, setRouteSaveState] = useState<'idle' | 'saving' | 'saved' | 'auth' | 'error'>('idle');
  const endRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<{ stop(): void } | null>(null);
  const { isDark, toggleTheme } = useTheme();

  useEffect(() => {
    setIsOffline(!navigator.onLine);
    const onOnline = () => setIsOffline(false);
    const onOffline = () => setIsOffline(true);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => { window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); };
  }, []);

  useEffect(() => {
    if (messages.length === 0) return;
    try {
      const toSave = messages.slice(-50);
      localStorage.setItem('th_ai_chat_history', JSON.stringify(toSave));
    } catch { /* ignore localStorage errors */ }
  }, [messages]);

  // История восстанавливается из localStorage — без прокрутки вниз на маунте
  // человек попадал в НАЧАЛО старой переписки, а свежий автоотправленный
  // запрос уезжал за экран («чат открылся сверху, запрос не попал»).
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'auto' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!initialQuery) return;
    setInput(initialQuery);
    const t = setTimeout(() => { void sendMessage(initialQuery); }, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function startVoice() {
    const w = window as unknown as Record<string, unknown>;
    type RecognitionLike = {
      lang: string; interimResults: boolean; maxAlternatives: number;
      onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
      onerror: (() => void) | null; onend: (() => void) | null;
      start(): void; stop(): void;
    };
    const Ctor = (w['SpeechRecognition'] || w['webkitSpeechRecognition']) as (new () => RecognitionLike) | undefined;
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = 'ru-RU'; rec.interimResults = false; rec.maxAlternatives = 1;
    rec.onresult = (e) => { setInput(e.results[0][0].transcript); setListening(false); };
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    rec.start();
    recognitionRef.current = rec;
    setListening(true);
  }

  function stopVoice() {
    recognitionRef.current?.stop();
    setListening(false);
  }

  async function sendMessage(text: string) {
    if (!text.trim() || loading || limitReached || isOffline) return;
    setMessages(prev => [...prev, { role: 'user', content: text }]);
    setInput('');
    setLoading(true);

    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, sessionId, role: 'tourist' }),
      });
      const data: unknown = await res.json();

      if (isRecord(data) && isRecord(data.data) && data.data.limitReached === true) {
        setLimitReached(true);
        const dd = data.data;
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: typeof dd.message === 'string'
            ? dd.message
            : 'Вы использовали все бесплатные сообщения. Зарегистрируйтесь, чтобы продолжить.',
        }]);
        return;
      }

      let reply = 'Извините, не удалось получить ответ. Попробуйте позже.';
      let tours: TourSuggestion[] | undefined;
      let routes: RouteRec[] | undefined;
      let warning: string | undefined;

      if (isRecord(data) && isRecord(data.data)) {
        const answer = data.data.answer;
        if (typeof answer === 'string') reply = answer;

        const rawTours = data.data.tours;
        if (Array.isArray(rawTours)) tours = rawTours.filter(isTourSuggestion);

        const rawRoutes = data.data.routes;
        if (Array.isArray(rawRoutes)) routes = rawRoutes.filter(isRouteRec);

        if (typeof data.data.warning === 'string') warning = data.data.warning;
        if (typeof data.data.remainingFree === 'number') setRemainingFree(data.data.remainingFree);
      }

      setMessages(prev => [...prev, {
        role: 'assistant', content: reply, tours, routes, warning,
        // AI лёг — не оставляем человека в тупике: прямая ссылка в каталог.
        searchFallback: isAiErrorReply(reply) ? text : undefined,
      }]);
      if (routes?.length) setRouteSaveState('idle');
    } catch {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: 'Сервер недоступен. При опасности звоните 112 (МЧС).',
        searchFallback: text,
      }]);
    } finally {
      setLoading(false);
      setTimeout(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
    }
  }

  const lastAssistantIdx = messages.map((m, i) => m.role === 'assistant' ? i : -1).filter(i => i >= 0).pop();

  return (
    <div className="min-h-screen pb-24 md:pb-0">
      {/* Header */}
      <header style={{ background: 'var(--bg-card)', borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, zIndex: 50 }}>
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <Link href="/" style={{ textDecoration: 'none', display: 'flex', alignItems: 'center' }}>
            <Logo size={28} />
          </Link>
          <h1 className="text-base font-bold text-[var(--text-primary)] hidden sm:block">Кузьмич AI</h1>
          <div className="flex items-center gap-3">
            <button onClick={toggleTheme} className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors" aria-label="Переключить тему">
              {isDark ? <Sun size={20} /> : <Moon size={20} />}
            </button>
            <Link href="/profile" className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors" aria-label="Личный кабинет">
              <User size={20} />
            </Link>
          </div>
        </div>
      </header>

      <div className="max-w-2xl mx-auto px-4 py-6 flex flex-col h-[calc(100vh-8rem)]">
        {/* Empty state */}
        {messages.length === 0 && (
          <div className="text-center py-12 text-[var(--text-muted)]">
            <div className="w-14 h-14 rounded-full bg-[var(--accent)]/10 flex items-center justify-center mx-auto mb-4">
              <Bot className="w-7 h-7 text-[var(--accent)]" />
            </div>
            <p className="text-[var(--text-primary)] font-medium mb-1">Ваш проводник по Камчатке</p>
            <p className="text-sm mb-5">Спросите о маршрутах, погоде, безопасности</p>
            <div className="flex flex-wrap justify-center gap-2">
              {['Куда сходить завтра?', 'Что взять в поход?', 'Погода на Мутновском', 'Нужна ли регистрация МЧС?'].map(q => (
                <button
                  key={q}
                  onClick={() => setInput(q)}
                  className="px-3 py-2 rounded-xl border border-[var(--border)] text-[var(--text-secondary)] text-sm hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors min-h-[44px]"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Messages */}
        <div className="flex-1 overflow-y-auto space-y-4 mb-4">
          {messages.map((msg, i) => (
            <div key={`${msg.role}-${i}`} className={`flex flex-col gap-2 ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
              <div className={`flex gap-2 ${msg.role === 'user' ? 'justify-end' : 'justify-start'} w-full`}>
                {msg.role === 'assistant' && (
                  <div className="w-7 h-7 rounded-full bg-[var(--accent)]/10 flex items-center justify-center shrink-0 mt-0.5">
                    <Bot className="w-4 h-4 text-[var(--accent)]" />
                  </div>
                )}
                <div className={`max-w-[80%] px-4 py-3 text-sm whitespace-pre-wrap ${
                  msg.role === 'user'
                    ? 'bg-[var(--accent)] text-white rounded-lg rounded-br-md'
                    : 'bg-[var(--bg-card)] text-[var(--text-primary)] rounded-lg rounded-bl-md border border-[var(--border)]'
                }`}>
                  {msg.content}
                </div>
                {msg.role === 'user' && (
                  <div className="w-7 h-7 rounded-full bg-[var(--bg-hover)] flex items-center justify-center shrink-0 mt-0.5">
                    <User className="w-4 h-4 text-[var(--text-muted)]" />
                  </div>
                )}
              </div>

              {/* Route cards */}
              {msg.role === 'assistant' && msg.routes && msg.routes.length > 0 && (
                <div className="ml-9 w-full max-w-[80%] space-y-2">
                  {msg.routes.map(route => <RouteCard key={route.id} route={route} />)}
                </div>
              )}

              {/* AI недоступен — прямой путь в каталог вместо тупика */}
              {msg.role === 'assistant' && msg.searchFallback && (
                <div className="ml-9 mt-1">
                  <Link
                    href={`/routes?q=${encodeURIComponent(msg.searchFallback)}`}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-full border border-[var(--ocean)]/40 text-xs text-[var(--ocean)] hover:border-[var(--ocean)] transition-colors min-h-[36px]"
                  >
                    <MapPin className="w-3.5 h-3.5" />
                    Найти «{msg.searchFallback.length > 40 ? msg.searchFallback.slice(0, 40) + '…' : msg.searchFallback}» в каталоге
                  </Link>
                </div>
              )}

              {/* Warning card */}
              {msg.role === 'assistant' && msg.warning && (
                <div className="ml-9 w-full max-w-[80%]">
                  <WarningCard text={msg.warning} />
                </div>
              )}

              {/* Tour cards */}
              {msg.role === 'assistant' && msg.tours && msg.tours.length > 0 && (
                <div className="ml-9 w-full max-w-[80%] space-y-2">
                  <p className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Подходящие туры</p>
                  {msg.tours.map(tour => <TourCard key={tour.id} tour={tour} />)}
                  <Link href="/marketplace" className="block text-xs text-[var(--ocean)] hover:underline pt-1">
                    Все туры на Камчатке
                  </Link>
                </div>
              )}

              {/* Quick-action chips after last assistant message */}
              {msg.role === 'assistant' && i === lastAssistantIdx && !loading && (
                <div className="ml-9 flex flex-wrap gap-2 mt-1">
                  <button
                    onClick={() => void sendMessage('Помоги заказать трансфер')}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-full border border-[var(--border)] bg-[var(--bg-card)] text-xs text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors min-h-[36px]"
                  >
                    <Car className="w-3.5 h-3.5" /> Заказать трансфер
                  </button>
                  <button
                    onClick={async () => {
                      // Раньше кнопка писала saved_route_id в localStorage,
                      // который никто не читал — сохранение было фикцией.
                      const lastRouteMsg = [...messages].reverse().find(m => m.routes?.length);
                      const route = lastRouteMsg?.routes?.[0];
                      if (!route || routeSaveState === 'saving' || routeSaveState === 'saved') return;
                      setRouteSaveState('saving');
                      try {
                        const res = await fetch('/api/tourist/wishlist', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ itemType: 'destination', itemId: route.id }),
                        });
                        if (res.status === 401 || res.status === 403) { setRouteSaveState('auth'); return; }
                        setRouteSaveState(res.ok ? 'saved' : 'error');
                      } catch {
                        setRouteSaveState('error');
                      }
                    }}
                    disabled={routeSaveState === 'saving'}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-full border border-[var(--border)] bg-[var(--bg-card)] text-xs text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors min-h-[36px] disabled:opacity-50"
                  >
                    {routeSaveState === 'saving' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Bookmark className="w-3.5 h-3.5" />}
                    {routeSaveState === 'saved' ? 'Сохранено в избранное'
                      : routeSaveState === 'auth' ? 'Войдите, чтобы сохранять'
                      : routeSaveState === 'error' ? 'Не удалось — ещё раз'
                      : 'Сохранить маршрут'}
                  </button>
                  <button
                    onClick={() => void sendMessage('Покажи другие варианты')}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-full border border-[var(--border)] bg-[var(--bg-card)] text-xs text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors min-h-[36px]"
                  >
                    <RefreshCw className="w-3.5 h-3.5" /> Другие варианты
                  </button>
                </div>
              )}
            </div>
          ))}

          {loading && (
            <div className="flex items-center gap-2 text-[var(--text-muted)] text-sm">
              <Loader2 className="w-4 h-4 animate-spin text-[var(--accent)]" />
              <span>Кузьмич думает...</span>
            </div>
          )}
          <div ref={endRef} />
        </div>

        {/* Limit notice */}
        {remainingFree !== null && remainingFree <= 3 && !limitReached && (
          <div className="text-xs text-center text-[var(--text-muted)] mb-2">
            Осталось {remainingFree} бесплатных сообщений
          </div>
        )}

        {/* Input bar */}
        <div className="sticky bottom-0 bg-[var(--bg-primary)] border-t border-[var(--border)] -mx-4 px-4 py-3">
          {isOffline && (
            <div className="flex items-center gap-2 mb-2 px-3 py-2 rounded-lg text-xs font-medium"
              style={{ background: 'color-mix(in srgb, var(--warning) 10%, var(--bg-card))', color: 'var(--warning)', border: '1px solid color-mix(in srgb, var(--warning) 25%, transparent)' }}>
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              Сеть недоступна. AI-консьерж работает в режиме чтения. SOS: 112
            </div>
          )}
          <form onSubmit={e => { e.preventDefault(); void sendMessage(input.trim()); }} className="flex gap-2">
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder="Спросите Кузьмича..."
              disabled={loading || limitReached || isOffline}
              className="flex-1 min-h-[44px] px-4 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30"
            />
            {/* Voice button */}
            <button
              type="button"
              onClick={listening ? stopVoice : startVoice}
              disabled={loading || limitReached || isOffline}
              className={`min-h-[44px] min-w-[44px] rounded-lg flex items-center justify-center transition-colors ${
                listening
                  ? 'bg-[var(--danger)] text-white'
                  : 'bg-[var(--bg-card)] border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--accent)] hover:border-[var(--accent)]'
              }`}
              aria-label={listening ? 'Остановить запись' : 'Голосовой ввод'}
            >
              {listening ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
            </button>
            {/* Send button */}
            <button
              type="submit"
              disabled={loading || !input.trim() || limitReached || isOffline}
              className="min-h-[44px] min-w-[44px] px-3 bg-[var(--accent)] text-white rounded-lg disabled:opacity-50 flex items-center justify-center hover:opacity-90 transition-opacity"
            >
              <Send className="w-5 h-5" />
            </button>
          </form>
        </div>
      </div>

      <BottomNav activePath="/ai-assistant" />
    </div>
  );
}

function AIAssistantPageInner() {
  const searchParams = useSearchParams();
  return <AIAssistantContent initialQuery={searchParams.get('q')} />;
}

export default function AIAssistantPage() {
  return (
    <Suspense fallback={<AIAssistantContent initialQuery={null} />}>
      <AIAssistantPageInner />
    </Suspense>
  );
}
