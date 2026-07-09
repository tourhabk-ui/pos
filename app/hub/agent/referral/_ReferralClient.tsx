'use client';

import { useCallback, useEffect, useState } from 'react';
import { Link2, MousePointerClick, TrendingUp, Wallet, Plus, Copy, Check, Loader2 } from 'lucide-react';

/**
 * Реферальные ссылки агента: список ссылок с кликами/конверсиями/заработком,
 * создание новой ссылки, копирование `?ref=CODE`. Данные — GET/POST
 * /api/hub/agent/referral (конверсии считаются из operator_bookings.referral_link_id).
 */

interface ReferralLink {
  id: string;
  code: string;
  tour_id: number | null;
  tour_title: string | null;
  clicks: number;
  conversions: number;
  commission_rate: string;
  earned_total: string;
  is_active: boolean;
  created_at: string;
}

interface Stats { totalClicks: number; totalConversions: number; totalEarned: number; }

function money(v: number): string {
  return new Intl.NumberFormat('ru-RU').format(Math.round(v)) + ' ₽';
}

export default function ReferralClient() {
  const [links, setLinks] = useState<ReferralLink[] | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [failed, setFailed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch('/api/hub/agent/referral')
      .then(r => (r.ok ? r.json() : null))
      .then((d: { success?: boolean; data?: ReferralLink[]; stats?: Stats } | null) => {
        if (d?.success && Array.isArray(d.data)) { setLinks(d.data); setStats(d.stats ?? null); }
        else setFailed(true);
      })
      .catch(() => setFailed(true));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function createLink() {
    setCreating(true);
    try {
      const res = await fetch('/api/hub/agent/referral', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commissionRate: 10 }),
      });
      if (res.ok) load();
    } catch {
      // ignore
    } finally {
      setCreating(false);
    }
  }

  function shareUrl(link: ReferralLink): string {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    return link.tour_id
      ? `${origin}/marketplace/tours/${link.tour_id}?ref=${link.code}`
      : `${origin}/?ref=${link.code}`;
  }

  async function copy(link: ReferralLink) {
    try {
      await navigator.clipboard.writeText(shareUrl(link));
      setCopied(link.id);
      setTimeout(() => setCopied(c => (c === link.id ? null : c)), 2000);
    } catch {
      // ignore
    }
  }

  return (
    <div className="p-5 lg:p-6 space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2.5">
          <Link2 className="w-4 h-4 text-[var(--text-muted)]" />
          <h1 className="text-sm font-semibold text-[var(--text-primary)] tracking-tight">Реферальные ссылки</h1>
        </div>
        <button onClick={createLink} disabled={creating} className="ds-btn ds-btn-primary text-xs">
          {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} Создать ссылку
        </button>
      </div>

      {stats && (
        <div className="grid grid-cols-3 gap-3">
          {[
            { icon: MousePointerClick, label: 'Клики', value: String(stats.totalClicks) },
            { icon: TrendingUp, label: 'Конверсии', value: String(stats.totalConversions) },
            { icon: Wallet, label: 'Заработано', value: money(stats.totalEarned) },
          ].map(s => (
            <div key={s.label} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
              <div className="flex items-center gap-1.5 text-[var(--text-muted)] mb-1.5">
                <s.icon className="w-3.5 h-3.5" />
                <span className="text-[10px] uppercase tracking-widest">{s.label}</span>
              </div>
              <p className="text-lg font-semibold text-[var(--text-primary)]">{s.value}</p>
            </div>
          ))}
        </div>
      )}

      {failed && <p className="text-sm text-[var(--danger)]">Не удалось загрузить ссылки. Обновите страницу.</p>}

      {links === null && !failed && (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => <div key={i} className="ds-skeleton h-16 rounded-lg" />)}
        </div>
      )}

      {links !== null && links.length === 0 && (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-8 text-center">
          <p className="text-sm text-[var(--text-secondary)] mb-1">Ссылок пока нет.</p>
          <p className="text-xs text-[var(--text-muted)]">Создайте ссылку и делитесь ей — брони по ней зачисляются вам.</p>
        </div>
      )}

      {links !== null && links.map(link => (
        <div key={link.id} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono text-sm font-semibold text-[var(--text-primary)]">{link.code}</span>
                <span className="text-xs text-[var(--text-muted)]">
                  {link.tour_title ?? 'Все туры'} · {Number(link.commission_rate)}%
                </span>
                {!link.is_active && <span className="ds-badge border border-[var(--border)] text-[var(--danger)]">неактивна</span>}
              </div>
              <p className="text-xs text-[var(--text-secondary)] mt-1.5">
                {link.clicks} кликов · {link.conversions} бронь(и) · заработано {money(Number(link.earned_total))}
              </p>
            </div>
            <button onClick={() => copy(link)} className="ds-btn ds-btn-secondary text-xs shrink-0">
              {copied === link.id ? <><Check className="w-3.5 h-3.5" /> Скопировано</> : <><Copy className="w-3.5 h-3.5" /> Ссылка</>}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
