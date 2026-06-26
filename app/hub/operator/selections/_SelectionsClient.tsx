'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Plus, Link2, Copy, Check, Eye, MousePointerClick,
  ShoppingBag, Clock, Trash2, Search, X, ChevronRight,
  Send, AlertCircle, Users,
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Tour {
  id: number;
  title: string;
  base_price: string;
  activity_type: string | null;
  duration_hours: number | null;
  duration_days: number | null;
  is_active: boolean;
}

interface Selection {
  id: string;
  code: string;
  title: string | null;
  client_name: string | null;
  client_phone: string | null;
  client_telegram: string | null;
  created_via: string;
  expires_at: string | null;
  created_at: string;
  tour_count: number;
  opens: number;
  tour_views: number;
  book_clicks: number;
  last_activity: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const INPUT = 'px-3 py-2 text-sm bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--ocean)] transition-colors w-full';

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'только что';
  if (m < 60) return `${m} мин назад`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ч назад`;
  return `${Math.floor(h / 24)} д назад`;
}

function formatDuration(hours: number | null, days: number | null): string {
  if (days && days >= 1) return `${days}д`;
  if (hours) return `${hours}ч`;
  return '';
}

function RUB(v: string | number | null) {
  if (v == null) return '—';
  return Number(v).toLocaleString('ru-RU') + ' ₽';
}

// ─── Stat chip ────────────────────────────────────────────────────────────────

function Stat({ icon: Icon, value, label, color }: {
  icon: React.ElementType; value: number; label: string; color: string;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '13px', color }}>
      <Icon size={13} />
      <strong>{value}</strong>
      <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>{label}</span>
    </div>
  );
}

// ─── Selection Card ────────────────────────────────────────────────────────────

function SelectionCard({ sel, onCopy }: { sel: Selection; onCopy: (code: string) => void }) {
  const url = `${typeof window !== 'undefined' ? window.location.origin : 'https://vedarai.ru'}/p/${sel.code}`;
  const isHot = sel.book_clicks > 0;
  const isWarm = sel.opens > 0 && sel.book_clicks === 0;

  return (
    <div className="ds-card" style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700, fontSize: '15px', color: 'var(--text-primary)' }}>
              {sel.title ?? `Подборка для ${sel.client_name ?? 'клиента'}`}
            </span>
            {isHot && (
              <span style={{ fontSize: '10px', fontWeight: 700, padding: '2px 6px', borderRadius: '4px', background: 'rgba(var(--danger-rgb,220,38,38),0.1)', color: 'var(--danger)' }}>
                🔥 ЗАЯВКА
              </span>
            )}
            {isWarm && !isHot && (
              <span style={{ fontSize: '10px', fontWeight: 700, padding: '2px 6px', borderRadius: '4px', background: 'rgba(var(--warning-rgb,210,153,34),0.1)', color: 'var(--warning)' }}>
                👀 СМОТРИТ
              </span>
            )}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {sel.client_name && <span><Users size={11} style={{ display: 'inline' }} /> {sel.client_name}</span>}
            {sel.client_phone && <span>{sel.client_phone}</span>}
            {sel.client_telegram && <span>@{sel.client_telegram.replace('@', '')}</span>}
          </div>
        </div>
        <button
          onClick={() => onCopy(sel.code)}
          title="Скопировать ссылку"
          style={{
            padding: '6px 10px', borderRadius: '8px', cursor: 'pointer',
            background: 'var(--bg-hover)', border: '1px solid var(--border)',
            color: 'var(--ocean)', display: 'flex', alignItems: 'center', gap: '4px',
            fontSize: '12px', fontWeight: 600, flexShrink: 0,
          }}
        >
          <Copy size={13} /> Ссылка
        </button>
      </div>

      {/* Stats */}
      <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap' }}>
        <Stat icon={ShoppingBag} value={sel.tour_count} label="туров" color="var(--text-secondary)" />
        <Stat icon={Eye}               value={sel.opens}       label="открытий"  color={sel.opens > 0 ? 'var(--ocean)' : 'var(--text-muted)'} />
        <Stat icon={MousePointerClick} value={sel.tour_views}  label="просмотров" color={sel.tour_views > 0 ? 'var(--ocean)' : 'var(--text-muted)'} />
        <Stat icon={ChevronRight}      value={sel.book_clicks} label="заявок"    color={sel.book_clicks > 0 ? 'var(--danger)' : 'var(--text-muted)'} />
      </div>

      {/* Footer */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px' }}>
          <Clock size={11} />
          {sel.last_activity ? timeAgo(sel.last_activity) : timeAgo(sel.created_at)}
        </span>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontSize: '12px', color: 'var(--ocean)', display: 'flex', alignItems: 'center', gap: '4px' }}
        >
          <Link2 size={12} /> {sel.code}
        </a>
      </div>
    </div>
  );
}

// ─── Tour Picker Item ──────────────────────────────────────────────────────────

function TourPickerItem({ tour, selected, note, onToggle, onNote }: {
  tour: Tour;
  selected: boolean;
  note: string;
  onToggle: () => void;
  onNote: (v: string) => void;
}) {
  const [editNote, setEditNote] = useState(false);

  return (
    <div
      style={{
        border: `2px solid ${selected ? 'var(--ocean)' : 'var(--border)'}`,
        borderRadius: '10px',
        overflow: 'hidden',
        transition: 'border-color 0.15s',
      }}
    >
      <div
        onClick={onToggle}
        style={{
          padding: '12px 14px',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          background: selected ? 'rgba(37,104,176,0.06)' : 'var(--bg-card)',
        }}
      >
        <div style={{
          width: '20px', height: '20px', borderRadius: '5px', flexShrink: 0,
          border: `2px solid ${selected ? 'var(--ocean)' : 'var(--border)'}`,
          background: selected ? 'var(--ocean)' : 'transparent',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'all 0.15s',
        }}>
          {selected && <Check size={13} color="#fff" strokeWidth={3} />}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: '14px', color: 'var(--text-primary)' }}>
            {tour.title}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px', display: 'flex', gap: '10px' }}>
            {tour.activity_type && <span>{tour.activity_type}</span>}
            {formatDuration(tour.duration_hours, tour.duration_days) && (
              <span>{formatDuration(tour.duration_hours, tour.duration_days)}</span>
            )}
          </div>
        </div>
        <div style={{ fontWeight: 700, color: 'var(--accent)', fontSize: '14px', flexShrink: 0 }}>
          {RUB(tour.base_price)}
        </div>
      </div>

      {selected && (
        <div style={{ padding: '0 14px 12px', background: 'rgba(37,104,176,0.04)' }}>
          {editNote ? (
            <div style={{ display: 'flex', gap: '6px' }}>
              <input
                className={INPUT}
                value={note}
                onChange={(e) => onNote(e.target.value)}
                placeholder="Заметка для клиента (необязательно)"
                autoFocus
                onBlur={() => setEditNote(false)}
                onKeyDown={(e) => e.key === 'Enter' && setEditNote(false)}
              />
            </div>
          ) : (
            <button
              onClick={() => setEditNote(true)}
              style={{ fontSize: '12px', color: 'var(--ocean)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0' }}
            >
              {note ? `✏️ ${note}` : '+ Добавить заметку клиенту'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Component ────────────────────────────────────────────────────────────

export default function SelectionsClient() {
  // List
  const [selections, setSelections] = useState<Selection[]>([]);
  const [loadingList, setLoadingList] = useState(true);

  // Builder
  const [showBuilder, setShowBuilder] = useState(false);
  const [tours, setTours] = useState<Tour[]>([]);
  const [loadingTours, setLoadingTours] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [notes, setNotes] = useState<Record<number, string>>({});

  // Form
  const [title, setTitle]           = useState('');
  const [clientName, setClientName] = useState('');
  const [clientPhone, setClientPhone] = useState('');
  const [clientTg, setClientTg]     = useState('');

  // Create state
  const [creating, setCreating]   = useState(false);
  const [created, setCreated]     = useState<{ code: string; url: string } | null>(null);
  const [createErr, setCreateErr] = useState<string | null>(null);

  // Copy
  const [copied, setCopied]       = useState<string | null>(null);

  const loadSelections = useCallback(async () => {
    setLoadingList(true);
    try {
      const r = await fetch('/api/hub/selections');
      const d = await r.json() as { selections: Selection[] };
      setSelections(d.selections ?? []);
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => { void loadSelections(); }, [loadSelections]);

  const openBuilder = async () => {
    setShowBuilder(true);
    setCreated(null);
    setCreateErr(null);
    setSelectedIds(new Set());
    setNotes({});
    setTitle('');
    setClientName('');
    setClientPhone('');
    setClientTg('');
    setSearch('');

    if (tours.length === 0) {
      setLoadingTours(true);
      try {
        const r = await fetch('/api/hub/operator/tours?limit=100');
        const d = await r.json() as { tours?: Tour[]; data?: Tour[] };
        setTours((d.tours ?? d.data ?? []).filter((t) => t.is_active));
      } finally {
        setLoadingTours(false);
      }
    }
  };

  const toggleTour = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleCreate = async () => {
    if (selectedIds.size === 0) { setCreateErr('Выберите хотя бы один тур'); return; }
    setCreating(true);
    setCreateErr(null);
    try {
      const res = await fetch('/api/hub/selections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title:           title || undefined,
          client_name:     clientName || undefined,
          client_phone:    clientPhone || undefined,
          client_telegram: clientTg || undefined,
          tour_ids:        [...selectedIds],
          notes:           Object.fromEntries(
            Object.entries(notes).filter(([, v]) => v.trim())
          ),
        }),
      });
      const d = await res.json() as { code?: string; url?: string; error?: string };
      if (!res.ok) throw new Error(d.error ?? 'Ошибка');
      const origin = window.location.origin;
      setCreated({ code: d.code!, url: `${origin}/p/${d.code}` });
      void loadSelections();
    } catch (e) {
      setCreateErr(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setCreating(false);
    }
  };

  const copyLink = (code: string) => {
    const url = `${window.location.origin}/p/${code}`;
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(code);
      setTimeout(() => setCopied(null), 2000);
    });
  };

  const filteredTours = tours.filter((t) =>
    !search || t.title.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div style={{ maxWidth: '900px', margin: '0 auto', padding: '24px 16px' }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <h1 className="ds-h1" style={{ fontSize: '24px', marginBottom: '4px' }}>Подборки туров</h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>
            Соберите персональный список туров для клиента — он получит красивую ссылку.
          </p>
        </div>
        <button className="ds-btn ds-btn-primary" onClick={() => void openBuilder()}>
          <Plus size={16} /> Создать подборку
        </button>
      </div>

      {/* Builder panel */}
      {showBuilder && (
        <div className="ds-card" style={{ padding: '24px', marginBottom: '24px' }}>
          {created ? (
            /* ── Success screen ── */
            <div style={{ textAlign: 'center', padding: '12px 0' }}>
              <div style={{ fontSize: '40px', marginBottom: '12px' }}>🎉</div>
              <h2 className="ds-h2" style={{ marginBottom: '8px' }}>Подборка создана!</h2>
              <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginBottom: '20px' }}>
                Отправьте ссылку клиенту — он увидит карточки туров и сможет записаться.
              </p>

              <div style={{
                display: 'flex', gap: '8px', alignItems: 'center',
                background: 'var(--bg-primary)', borderRadius: '10px',
                padding: '12px 14px', marginBottom: '16px',
                border: '1px solid var(--border)',
              }}>
                <Link2 size={16} style={{ color: 'var(--ocean)', flexShrink: 0 }} />
                <span style={{ flex: 1, fontSize: '14px', wordBreak: 'break-all', color: 'var(--text-primary)' }}>
                  {created.url}
                </span>
                <button
                  onClick={() => copyLink(created.code)}
                  className="ds-btn ds-btn-primary"
                  style={{ padding: '6px 14px', fontSize: '13px', flexShrink: 0 }}
                >
                  {copied === created.code ? <><Check size={13} /> Скопировано</> : <><Copy size={13} /> Копировать</>}
                </button>
              </div>

              {clientTg && (
                <a
                  href={`https://t.me/${clientTg.replace('@', '')}?text=${encodeURIComponent(`Ваша подборка туров: ${created.url}`)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ds-btn ds-btn-secondary"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', marginRight: '8px' }}
                >
                  <Send size={14} /> Отправить в Telegram
                </a>
              )}

              <button
                className="ds-btn ds-btn-secondary"
                onClick={() => { setShowBuilder(false); setCreated(null); }}
              >
                Готово
              </button>
            </div>
          ) : (
            /* ── Builder form ── */
            <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap' }}>

              {/* Left: tour picker */}
              <div style={{ flex: '1 1 340px', minWidth: '280px' }}>
                <div style={{ fontWeight: 700, fontSize: '15px', marginBottom: '12px', color: 'var(--text-primary)' }}>
                  Выберите туры
                  {selectedIds.size > 0 && (
                    <span style={{ marginLeft: '8px', fontSize: '12px', fontWeight: 600, color: 'var(--ocean)', background: 'rgba(37,104,176,0.1)', padding: '2px 8px', borderRadius: '12px' }}>
                      {selectedIds.size}
                    </span>
                  )}
                </div>

                <div style={{ position: 'relative', marginBottom: '10px' }}>
                  <Search size={15} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
                  <input
                    className={INPUT}
                    style={{ paddingLeft: '32px' }}
                    placeholder="Поиск тура…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '380px', overflowY: 'auto' }}>
                  {loadingTours ? (
                    Array.from({ length: 4 }).map((_, i) => (
                      <div key={i} className="ds-skeleton" style={{ height: '56px', borderRadius: '10px' }} />
                    ))
                  ) : filteredTours.length === 0 ? (
                    <p style={{ color: 'var(--text-muted)', fontSize: '13px', padding: '8px 0' }}>
                      {search ? 'Ничего не найдено' : 'Нет активных туров'}
                    </p>
                  ) : (
                    filteredTours.map((tour) => (
                      <TourPickerItem
                        key={tour.id}
                        tour={tour}
                        selected={selectedIds.has(tour.id)}
                        note={notes[tour.id] ?? ''}
                        onToggle={() => toggleTour(tour.id)}
                        onNote={(v) => setNotes((p) => ({ ...p, [tour.id]: v }))}
                      />
                    ))
                  )}
                </div>
              </div>

              {/* Right: client info + create */}
              <div style={{ flex: '0 0 260px', minWidth: '220px' }}>
                <div style={{ fontWeight: 700, fontSize: '15px', marginBottom: '12px', color: 'var(--text-primary)' }}>
                  Данные клиента
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <div>
                    <label className="ds-label">Название подборки</label>
                    <input
                      className={INPUT}
                      placeholder="Туры для Тараса, август"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="ds-label">Имя клиента</label>
                    <input
                      className={INPUT}
                      placeholder="Тарас"
                      value={clientName}
                      onChange={(e) => setClientName(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="ds-label">Телефон</label>
                    <input
                      className={INPUT}
                      type="tel"
                      placeholder="+7 900 000 00 00"
                      value={clientPhone}
                      onChange={(e) => setClientPhone(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="ds-label">Telegram</label>
                    <input
                      className={INPUT}
                      placeholder="@username"
                      value={clientTg}
                      onChange={(e) => setClientTg(e.target.value)}
                    />
                  </div>

                  {createErr && (
                    <div style={{ display: 'flex', gap: '6px', color: 'var(--danger)', fontSize: '13px', alignItems: 'flex-start' }}>
                      <AlertCircle size={14} style={{ flexShrink: 0, marginTop: '2px' }} />
                      {createErr}
                    </div>
                  )}

                  <button
                    className="ds-btn ds-btn-primary"
                    onClick={() => void handleCreate()}
                    disabled={creating || selectedIds.size === 0}
                    style={{ marginTop: '4px' }}
                  >
                    {creating ? 'Создаём…' : `Создать подборку${selectedIds.size > 0 ? ` (${selectedIds.size})` : ''}`}
                  </button>
                  <button
                    className="ds-btn ds-btn-secondary"
                    onClick={() => setShowBuilder(false)}
                  >
                    <X size={14} /> Отмена
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Selections list */}
      {loadingList ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="ds-skeleton" style={{ height: '110px', borderRadius: '12px' }} />
          ))}
        </div>
      ) : selections.length === 0 ? (
        <div style={{
          textAlign: 'center', padding: '48px 24px',
          color: 'var(--text-secondary)', border: '1px dashed var(--border)',
          borderRadius: '12px',
        }}>
          <ShoppingBag size={36} style={{ color: 'var(--text-muted)', marginBottom: '12px' }} />
          <p style={{ fontWeight: 600, marginBottom: '6px' }}>Пока нет подборок</p>
          <p style={{ fontSize: '14px' }}>
            Создайте первую подборку — выберите туры, укажите имя клиента и отправьте ссылку.
          </p>
        </div>
      ) : (
        <div>
          <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '12px' }}>
            {selections.length} {selections.length === 1 ? 'подборка' : selections.length < 5 ? 'подборки' : 'подборок'}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {selections.map((sel) => (
              <SelectionCard
                key={sel.id}
                sel={sel}
                onCopy={(code) => {
                  copyLink(code);
                }}
              />
            ))}
          </div>
        </div>
      )}

      {/* Copied toast */}
      {copied && (
        <div style={{
          position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)',
          background: 'var(--text-primary)', color: 'var(--bg-primary)',
          padding: '10px 20px', borderRadius: '20px', fontSize: '13px',
          fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px',
          zIndex: 9999, pointerEvents: 'none',
          boxShadow: '0 4px 20px rgba(0,0,0,0.2)',
        }}>
          <Check size={14} /> Ссылка скопирована
        </div>
      )}
    </div>
  );
}
