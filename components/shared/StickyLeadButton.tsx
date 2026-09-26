'use client';

import { useState, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { MessageSquarePlus, X, User, Phone, Sparkles, Send, CheckCircle, MessageCircle } from 'lucide-react';
import { trackLeadEvent, LEAD_EVENTS } from '@/lib/analytics/lead-tracking';
import { PdConsentCheckbox } from '@/components/legal/PdConsentCheckbox';

type State = 'idle' | 'form' | 'sending' | 'done' | 'error';

/**
 * Высота нижней панели действий САМОЙ страницы (например, «Назад / Дальше»
 * анкеты /planner). Страница выставляет её сама, как BottomNav — свою; где
 * панели нет — переменной нет, и срабатывает запас 0px. Кнопку не прячем:
 * владелец оставил её и на планировщике (26.09), она поднимается над панелью.
 */
export const PAGE_ACTION_BAR_VAR = '--page-action-bar-h';

/**
 * Отступ кнопки снизу: высота таб-бара (переменная, которую выставляет
 * BottomNav; где бара нет — 0px) либо safe-area, плюс панель действий
 * страницы, если она есть, плюс 16px воздуха.
 */
const FAB_BOTTOM = `calc(max(var(--bottom-nav-h, 0px), env(safe-area-inset-bottom, 0px)) + var(${PAGE_ACTION_BAR_VAR}, 0px) + 16px)`;

/**
 * Глобальная sticky-кнопка "Хочу тур" — видна на всех страницах.
 * Открывает компактную форму лида прямо в попапе.
 * Скрывается на страницах /hub/* (внутренние дашборды).
 */
export default function StickyLeadButton() {
  const pathname = usePathname();
  const [open, setOpen]       = useState(false);
  const [name, setName]       = useState('');
  const [phone, setPhone]     = useState('');
  const [comment, setComment] = useState('');
  const [state, setState]     = useState<State>('form');
  const [pdConsent, setPdConsent] = useState(false);

  // Отслеживаем открытие формы
  useEffect(() => {
    if (open) {
      trackLeadEvent({ ...LEAD_EVENTS.OPEN_LEAD_FORM_PHONE, source: 'sticky_button' });
    }
  }, [open]);

  // Детальная карточка тура — свой контекстный CTA с ценой (нижняя панель в
  // TourDetailClient, аудит мобильной компоновки, этап 2). Безадресная заявка
  // «Хочу тур» рядом с заявкой на КОНКРЕТНЫЙ тур — два контура бронирования;
  // к тому же на ширине меньше sm у кнопки скрыта подпись, и она стояла одной
  // иконкой поверх начала «О туре». Списки (/marketplace, /catalog) не
  // задеты: скрываем только /tours/ подпути.
  // /planning — полевой контур (скрин владельца 27.08): коммерческая кнопка
  // висела поверх навигатора рядом с компасом. В поле не продают.
  // /kuzmich — там уже живой чат, вторая кнопка ложилась поверх текста;
  // /auth — на входе перекрывала «Вернуться на главную» (#1780).
  // /booking-success — заявка только что создана; безадресная вторая заявка
  // рядом с ней — тот же второй контур, что и на карточке тура, и на
  // телефоне кнопка ложилась на «Договор (PDF)» и «Мои бронирования»
  // (аудит П1, #143/#145/#148).
  const HIDDEN_PATHS = ['/hub', '/sos', '/register', '/safety', '/offline', '/marketplace/tours/', '/catalog/tours/', '/booking-success', '/planning', '/field-check', '/kuzmich', '/auth'];
  if (!pathname || HIDDEN_PATHS.some(p => pathname.startsWith(p)) || pathname === '/') return null;

  async function submitLead(e: React.FormEvent) {
    e.preventDefault();
    if (!pdConsent) return;
    setState('sending');
    trackLeadEvent({ ...LEAD_EVENTS.SUBMIT_LEAD, source: 'sticky_button' });
    try {
      const res = await fetch('/api/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim() || 'Turист',
          phone: phone.trim(),
          comment: comment.trim() || undefined,
          source_url: typeof window !== 'undefined' ? window.location.href : '/',
          source_data: { source: 'sticky_cta' },
          pd_consent: true,
        }),
      });
      if (res.ok) {
        trackLeadEvent({ ...LEAD_EVENTS.LEAD_SUCCESS, source: 'sticky_button' });
        setState('done');
      } else {
        trackLeadEvent({ ...LEAD_EVENTS.LEAD_ERROR, source: 'sticky_button' });
        setState('error');
      }
    } catch {
      trackLeadEvent({ ...LEAD_EVENTS.LEAD_ERROR, source: 'sticky_button' });
      setState('error');
    }
  }

  function reset() {
    setOpen(false);
    setTimeout(() => { setName(''); setPhone(''); setComment(''); setState('form'); }, 300);
  }

  return (
    <>

      {/* Popover form — над кнопкой, то есть тоже над таб-баром */}
      {open && (
        <div
          className="fixed right-4 z-50 w-80 max-w-[calc(100vw-2rem)] rounded-xl shadow-2xl border overflow-hidden"
          style={{ bottom: `calc(${FAB_BOTTOM} + 68px)`, background: 'var(--bg-card)', borderColor: 'var(--border)' }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'var(--border)' }}>
            <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              Подобрать тур на Камчатку
            </p>
            <button onClick={reset} className="p-1 rounded hover:bg-[var(--bg-hover)] transition-colors">
              <X className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
            </button>
          </div>

          {/* Body */}
          <div className="p-4">
            {state === 'done' ? (
              <div className="flex flex-col items-center py-4 gap-3 text-center">
                <CheckCircle className="w-10 h-10" style={{ color: 'var(--success)' }} />
                <p className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>Заявка принята!</p>
                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>Менеджер перезвонит скоро.</p>
                <button onClick={reset} className="text-xs underline" style={{ color: 'var(--text-muted)' }}>Закрыть</button>
              </div>
            ) : (
              <>
                {/* Мессенджеры */}
                <div className="flex gap-2 mb-3">
                  <a
                    href="https://t.me/kuzmichai_bot?start=lead"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-xs font-semibold text-white transition-opacity hover:opacity-90"
                    style={{ background: 'var(--telegram)' }}
                  >
                    <MessageCircle className="w-3.5 h-3.5" /> Telegram
                  </a>
                  <a
                    href="https://max.ru/id4101147649_bot"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-xs font-semibold text-white transition-opacity hover:opacity-90"
                    style={{ background: 'var(--purple)' }}
                  >
                    <MessageCircle className="w-3.5 h-3.5" /> MAX
                  </a>
                </div>

                <div className="flex items-center gap-2 mb-3">
                  <div className="flex-1 h-px" style={{ background: 'var(--border)' }} />
                  <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>или оставьте телефон</span>
                  <div className="flex-1 h-px" style={{ background: 'var(--border)' }} />
                </div>

                <form onSubmit={submitLead} className="space-y-2.5">
                <div className="relative">
                  <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: 'var(--text-muted)' }} />
                  <input
                    type="tel" value={phone} onChange={e => setPhone(e.target.value)}
                    placeholder="+7 900 000 00 00" autoFocus required
                    className="ds-input w-full pl-8 pr-3 py-2 text-sm"
                  />
                </div>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5" style={{ color: 'var(--text-muted)' }} />
                  <input
                    type="text" value={name} onChange={e => setName(e.target.value)}
                    placeholder="Ваше имя (необязательно)"
                    className="ds-input w-full pl-8 pr-3 py-2 text-sm"
                  />
                </div>
                <div className="relative">
                  <Sparkles className="absolute left-3 top-3 w-3.5 h-3.5" style={{ color: 'var(--text-muted)' }} />
                  <textarea
                    value={comment} onChange={e => setComment(e.target.value)}
                    placeholder="Что хотите? Вулканы, рыбалка, даты..."
                    rows={2}
                    className="ds-input w-full pl-8 pr-3 py-2 text-sm resize-none"
                  />
                </div>
                {state === 'error' && (
                  <p className="text-xs" style={{ color: 'var(--danger)' }}>Ошибка. Попробуйте ещё раз.</p>
                )}
                <PdConsentCheckbox checked={pdConsent} onChange={setPdConsent} id="pd-consent-sticky" />
                <button
                  type="submit"
                  disabled={state === 'sending' || !phone.trim() || !pdConsent}
                  className="ds-btn ds-btn-primary w-full flex items-center justify-center gap-2 text-sm py-2.5 disabled:opacity-50"
                >
                  <Send className="w-3.5 h-3.5" />
                  {state === 'sending' ? 'Отправляю...' : 'Оставить заявку'}
                </button>
              </form>
              </>
            )}
          </div>
        </div>
      )}

      {/*
        FAB. До 24.09: в покое прозрачность 70%, вечная пульсация на
        @keyframes внутри компонента (запрещено §3), на телефоне одна иконка
        без подписи и `bottom-4` без учёта таб-бара — на /menu кнопка лежала
        под пунктом «На маршруте» и не нажималась (аудит П1, #61/#107/#131).
        Теперь: непрозрачная, с подписью на любой ширине, над баром по его
        собственной высоте (--bottom-nav-h, выставляет BottomNav).
        Сторож: tests/unit/sticky-lead-fab.test.tsx.
      */}
      <button
        onClick={() => {
          setOpen(v => !v);
          if (!open) {
            trackLeadEvent({ ...LEAD_EVENTS.CLICK_LEAD_BUTTON, source: 'sticky_button' });
          }
        }}
        className="fixed right-4 z-50 flex items-center justify-center gap-2 px-4 min-h-[48px] rounded-full shadow-lg text-sm font-bold text-white transition-transform duration-200 hover:scale-105 active:scale-[0.96]"
        style={{ bottom: FAB_BOTTOM, background: 'var(--accent)' }}
        aria-label="Оставить заявку на тур"
      >
        <MessageSquarePlus className="w-5 h-5" />
        <span className="sm:hidden">Подобрать тур</span>
        <span className="hidden sm:inline">Хочу тур</span>
      </button>
    </>
  );
}
