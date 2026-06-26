'use client';

import { useEffect, useState, useCallback } from 'react';
import { MapPin, Clock, Shield, AlertTriangle, Phone, ChevronRight, Users } from 'lucide-react';

interface TourItem {
  item_id: string;
  tour_id: number;
  position: number;
  note: string | null;
  title: string;
  base_price: number;
  activity_type: string | null;
  duration_hours: number | null;
  duration_days: number | null;
  difficulty: string | null;
  description: string | null;
  photo_url: string | null;
  hazards: string[] | null;
  mchs_registration_required: boolean | null;
}

interface Selection {
  id: string;
  title: string | null;
  client_name: string | null;
  operator_name: string | null;
  expires_at: string | null;
  tours: TourItem[];
}

const DIFFICULTY_LABEL: Record<string, string> = {
  easy: 'Лёгкий', medium: 'Средний', hard: 'Сложный', expert: 'Для опытных',
};

function formatDuration(hours: number | null, days: number | null): string {
  if (days && days >= 1) return `${days} ${days === 1 ? 'день' : days < 5 ? 'дня' : 'дней'}`;
  if (hours) return `${hours} ч`;
  return '';
}

function TourCard({ item, onView, onBook }: {
  item: TourItem;
  onView: () => void;
  onBook: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const handleClick = () => {
    onView();
    setExpanded(true);
  };

  return (
    <div
      className="ds-card overflow-hidden cursor-pointer"
      style={{ borderRadius: '12px' }}
      onClick={handleClick}
    >
      {item.photo_url && (
        <div style={{ height: '200px', overflow: 'hidden', position: 'relative' }}>
          <img
            src={item.photo_url}
            alt={item.title}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
          {item.mchs_registration_required && (
            <div style={{
              position: 'absolute', top: '10px', right: '10px',
              background: 'var(--warning)', color: '#fff',
              fontSize: '11px', fontWeight: 700, padding: '3px 8px', borderRadius: '6px',
            }}>
              МЧС
            </div>
          )}
        </div>
      )}

      <div style={{ padding: '16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
          <div style={{ flex: 1 }}>
            {item.activity_type && (
              <span style={{
                fontSize: '11px', fontWeight: 700, letterSpacing: '0.05em',
                color: 'var(--ocean)', textTransform: 'uppercase',
              }}>
                {item.activity_type}
              </span>
            )}
            <h3 className="ds-h2" style={{ marginTop: '4px', marginBottom: '8px', fontSize: '18px' }}>
              {item.title}
            </h3>
          </div>
          <div style={{ textAlign: 'right', flexShrink: 0 }}>
            <div style={{ fontSize: '22px', fontWeight: 800, color: 'var(--accent)' }}>
              {item.base_price.toLocaleString('ru-RU')} ₽
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>за человека</div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '12px' }}>
          {formatDuration(item.duration_hours, item.duration_days) && (
            <span style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '13px', color: 'var(--text-secondary)' }}>
              <Clock size={14} />
              {formatDuration(item.duration_hours, item.duration_days)}
            </span>
          )}
          {item.difficulty && (
            <span style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '13px', color: 'var(--text-secondary)' }}>
              <MapPin size={14} />
              {DIFFICULTY_LABEL[item.difficulty] ?? item.difficulty}
            </span>
          )}
          {(item.hazards?.length ?? 0) > 0 && (
            <span style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '13px', color: 'var(--warning)' }}>
              <AlertTriangle size={14} />
              Опасности
            </span>
          )}
        </div>

        {item.note && (
          <div style={{
            background: 'var(--bg-hover)', borderRadius: '8px',
            padding: '10px 12px', marginBottom: '12px',
            fontSize: '13px', color: 'var(--text-secondary)',
            borderLeft: '3px solid var(--ocean)',
          }}>
            {item.note}
          </div>
        )}

        {expanded && item.description && (
          <p style={{ fontSize: '14px', color: 'var(--text-secondary)', marginBottom: '12px', lineHeight: 1.6 }}>
            {item.description.slice(0, 400)}{item.description.length > 400 ? '…' : ''}
          </p>
        )}

        {expanded && (item.hazards?.length ?? 0) > 0 && (
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '12px' }}>
            {item.hazards!.map((h) => (
              <span key={h} className="ds-badge" style={{ background: 'rgba(var(--warning-rgb,210,153,34),0.12)', color: 'var(--warning)', fontSize: '11px' }}>
                {h}
              </span>
            ))}
          </div>
        )}

        <button
          className="ds-btn ds-btn-primary"
          style={{ width: '100%', marginTop: '4px' }}
          onClick={(e) => { e.stopPropagation(); onBook(); }}
        >
          Записаться на тур
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}

export default function SelectionClient({ code }: { code: string }) {
  const [sel, setSel] = useState<Selection | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [bookTour, setBookTour] = useState<TourItem | null>(null);

  // Booking form state
  const [name, setName]       = useState('');
  const [phone, setPhone]     = useState('');
  const [date, setDate]       = useState('');
  const [people, setPeople]   = useState(1);
  const [sending, setSending] = useState(false);
  const [sent, setSent]       = useState(false);
  const [bookErr, setBookErr] = useState<string | null>(null);

  const logEvent = useCallback((type: 'open' | 'tour_view' | 'book_click', itemId?: string) => {
    fetch(`/api/p/${code}/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_type: type, item_id: itemId }),
    }).catch(() => {});
  }, [code]);

  useEffect(() => {
    fetch(`/api/p/${code}`)
      .then((r) => {
        if (!r.ok) throw new Error(r.status === 410 ? 'Подборка устарела или удалена' : 'Не найдено');
        return r.json() as Promise<Selection>;
      })
      .then((data) => {
        setSel(data);
        setLoading(false);
        logEvent('open');
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : 'Ошибка');
        setLoading(false);
      });
  }, [code, logEvent]);

  const handleBook = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bookTour) return;
    setSending(true);
    setBookErr(null);
    try {
      const res = await fetch('/api/hub/bookings/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tour_id:            bookTour.tour_id,
          tourist_name:       name,
          tourist_phone:      phone,
          participants_count: people,
          booking_date:       date,
        }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Ошибка');
      setSent(true);
    } catch (err) {
      setBookErr(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setSending(false);
    }
  };

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="ds-skeleton" style={{ width: '200px', height: '24px', borderRadius: '8px' }} />
      </div>
    );
  }

  if (error || !sel) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px' }}>
        <AlertTriangle size={40} style={{ color: 'var(--text-muted)' }} />
        <p style={{ color: 'var(--text-secondary)' }}>{error ?? 'Подборка не найдена'}</p>
      </div>
    );
  }

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-primary)', paddingBottom: '60px' }}>
      {/* Header */}
      <div style={{
        background: 'var(--bg-card)', borderBottom: '1px solid var(--border)',
        padding: '20px 24px',
      }}>
        <div style={{ maxWidth: '720px', margin: '0 auto' }}>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>
            {sel.operator_name ?? 'Ведар'} · Персональная подборка
          </div>
          <h1 className="ds-h1" style={{ fontSize: '24px', marginBottom: sel.client_name ? '4px' : '0' }}>
            {sel.title ?? 'Туры для вас'}
          </h1>
          {sel.client_name && (
            <p style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>
              <Users size={14} style={{ display: 'inline', marginRight: '4px' }} />
              {sel.client_name}
            </p>
          )}
        </div>
      </div>

      {/* Tours */}
      <div style={{ maxWidth: '720px', margin: '0 auto', padding: '24px 16px' }}>
        <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginBottom: '20px' }}>
          {sel.tours.length} {sel.tours.length === 1 ? 'тур' : sel.tours.length < 5 ? 'тура' : 'туров'} специально подобраны для вас.
          Нажмите на любой, чтобы узнать подробнее, и запишитесь прямо здесь.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {sel.tours.map((item) => (
            <TourCard
              key={item.item_id}
              item={item}
              onView={() => logEvent('tour_view', item.item_id)}
              onBook={() => {
                logEvent('book_click', item.item_id);
                setBookTour(item);
                setSent(false);
                setBookErr(null);
              }}
            />
          ))}
        </div>

        {/* Footer */}
        <div style={{
          marginTop: '32px', padding: '16px', borderRadius: '10px',
          background: 'var(--bg-card)', textAlign: 'center',
          fontSize: '13px', color: 'var(--text-muted)',
        }}>
          <Shield size={16} style={{ display: 'inline', marginRight: '6px', color: 'var(--success)' }} />
          Безопасность туристов — приоритет Ведар.
          Вопросы? {' '}
          <a href="https://t.me/KuzmichKam_bot" style={{ color: 'var(--ocean)' }}>
            Спросите Кузьмича
          </a>
        </div>
      </div>

      {/* Booking modal */}
      {bookTour && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
            zIndex: 1000, padding: '0',
          }}
          onClick={() => setBookTour(null)}
        >
          <div
            style={{
              background: 'var(--bg-card)', borderRadius: '16px 16px 0 0',
              width: '100%', maxWidth: '720px', padding: '24px',
              maxHeight: '90vh', overflowY: 'auto',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {sent ? (
              <div style={{ textAlign: 'center', padding: '24px 0' }}>
                <div style={{ fontSize: '48px', marginBottom: '12px' }}>✓</div>
                <h2 className="ds-h2" style={{ marginBottom: '8px' }}>Заявка отправлена!</h2>
                <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginBottom: '20px' }}>
                  Оператор свяжется с вами в ближайшее время.
                </p>
                <button className="ds-btn ds-btn-secondary" onClick={() => setBookTour(null)}>
                  Вернуться к подборке
                </button>
              </div>
            ) : (
              <>
                <h2 className="ds-h2" style={{ marginBottom: '4px' }}>{bookTour.title}</h2>
                <p style={{ color: 'var(--accent)', fontWeight: 700, marginBottom: '20px' }}>
                  {bookTour.base_price.toLocaleString('ru-RU')} ₽ / чел.
                </p>

                <form onSubmit={(e) => { void handleBook(e); }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    <div>
                      <label className="ds-label">Ваше имя *</label>
                      <input className="ds-input" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Иван Петров" />
                    </div>
                    <div>
                      <label className="ds-label">Телефон *</label>
                      <input className="ds-input" required type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+7 900 000 00 00" />
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                      <div>
                        <label className="ds-label">Дата *</label>
                        <input className="ds-input" required type="date" min={today} value={date} onChange={(e) => setDate(e.target.value)} />
                      </div>
                      <div>
                        <label className="ds-label">Участников</label>
                        <input className="ds-input" type="number" min={1} max={20} value={people} onChange={(e) => setPeople(parseInt(e.target.value, 10) || 1)} />
                      </div>
                    </div>

                    {bookTour.mchs_registration_required && (
                      <div style={{
                        padding: '10px 12px', borderRadius: '8px',
                        background: 'rgba(210,153,34,0.1)', border: '1px solid var(--warning)',
                        fontSize: '13px', display: 'flex', gap: '8px',
                      }}>
                        <Phone size={14} style={{ color: 'var(--warning)', flexShrink: 0, marginTop: '2px' }} />
                        <span>Этот маршрут требует <strong>регистрации в МЧС</strong>. Оператор поможет с оформлением.</span>
                      </div>
                    )}

                    {bookErr && (
                      <p style={{ color: 'var(--danger)', fontSize: '13px' }}>{bookErr}</p>
                    )}

                    <button className="ds-btn ds-btn-primary" type="submit" disabled={sending} style={{ marginTop: '4px' }}>
                      {sending ? 'Отправляем…' : 'Отправить заявку'}
                    </button>
                    <button className="ds-btn ds-btn-secondary" type="button" onClick={() => setBookTour(null)}>
                      Отмена
                    </button>
                  </div>
                </form>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
