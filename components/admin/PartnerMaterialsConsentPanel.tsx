'use client';

/**
 * Согласие партнёра на использование материалов его сайта — блок в карточке
 * партнёра в админке (миграция 1321, решение владельца 23.10: «нужна форма
 * согласия об использовании матерьялов сайтов партнеров на нашем сайте»).
 *
 * Показывает три исхода, а не два (§4.0): согласие есть (кто, когда, объём) /
 * согласия нет / не смогли прочитать. Выпускает одноразовую ссылку на 30 дней
 * с готовым текстом для пересылки в MAX или Telegram (ключ показывается один
 * раз, в базе только хэш) и записывает отзыв со слов партнёра с причиной.
 */

import { useEffect, useState } from 'react';
import { Check, Copy, FileSignature, Loader2, Link2, XCircle } from 'lucide-react';
import {
  CONSENT_SURFACES, MATERIAL_KINDS, MATERIAL_WORDS, SURFACE_WORDS, siteWords,
  type ConsentSurface, type MaterialKind,
} from '@/lib/legal/partner-materials-consent';

interface ConsentView {
  id: string;
  grantedOn: string;
  textVersion: string;
  materials: MaterialKind[];
  surfaces: ConsentSurface[];
  sites: string[];
  signerName: string;
  signerRole: string;
  revokedAt: string | null;
  revokeReason: string | null;
}

interface InviteView { issuedAt: string; expiresAt: string; usedAt: string | null }

type Load =
  | { state: 'loading' }
  | { state: 'ok'; consents: ConsentView[]; invite: InviteView | null }
  | { state: 'failed'; message: string };

const SURFACE_SHORT: Record<ConsentSurface, string> = {
  own_page: 'своя страница',
  showcases: 'общие витрины',
  assistants: 'Кузьмич и ИИ-агенты',
  channel: 'каналы Ведара',
};

/** Чтение состояния: три исхода, отказ — словами, а не «согласия нет». */
async function fetchConsents(partnerId: string): Promise<Load> {
  try {
    const res = await fetch(`/api/admin/partners/${partnerId}/material-consent`);
    const body = await res.json().catch(() => null) as
      | { success?: boolean; error?: string; data?: { consents: ConsentView[]; invite: InviteView | null } }
      | null;
    if (!res.ok || !body?.success || !body.data) {
      return { state: 'failed', message: body?.error ?? 'Не смогли прочитать согласия партнёра.' };
    }
    return { state: 'ok', consents: body.data.consents, invite: body.data.invite };
  } catch {
    return { state: 'failed', message: 'Нет связи с сервером — согласия не прочитаны.' };
  }
}

export function PartnerMaterialsConsentPanel({ partnerId }: { partnerId: string }) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [issued, setIssued] = useState<{ text: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [reason, setReason] = useState('');

  // Счётчик перечтения: выпуск ссылки и отзыв меняют состояние на сервере.
  const [version, setVersion] = useState(0);
  const refresh = () => setVersion((v) => v + 1);

  useEffect(() => {
    let cancelled = false;
    void fetchConsents(partnerId).then((next) => { if (!cancelled) setLoad(next); });
    return () => { cancelled = true; };
  }, [partnerId, version]);

  async function issue() {
    setBusy(true); setError(null); setCopied(false);
    try {
      const res = await fetch(`/api/admin/partners/${partnerId}/material-consent`, { method: 'POST' });
      const body = await res.json().catch(() => null) as { success?: boolean; error?: string; data?: { text: string; expires_at: string } } | null;
      if (!res.ok || !body?.success || !body.data) { setError(body?.error ?? 'Ссылка не выпущена.'); return; }
      setIssued({ text: body.data.text, expiresAt: body.data.expires_at });
      refresh();
    } catch {
      setError('Нет связи с сервером — ссылка не выпущена.');
    } finally { setBusy(false); }
  }

  async function revoke() {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/admin/partners/${partnerId}/material-consent`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }),
      });
      const body = await res.json().catch(() => null) as { success?: boolean; error?: string } | null;
      if (!res.ok || !body?.success) { setError(body?.error ?? 'Отзыв не записан.'); return; }
      setRevoking(false); setReason('');
      refresh();
    } catch {
      setError('Нет связи с сервером — отзыв не записан.');
    } finally { setBusy(false); }
  }

  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setCopied(true); } catch { setError('Не удалось скопировать — выделите текст вручную.'); }
  }

  const active = load.state === 'ok' ? load.consents.find((c) => !c.revokedAt) ?? null : null;

  return (
    <section className="mt-3 border-t border-[var(--border)] pt-3 space-y-2" aria-labelledby="materials-consent-title">
      <div className="flex items-center justify-between gap-2">
        <h3 id="materials-consent-title" className="flex items-center gap-2 text-xs font-medium text-[var(--text-primary)]">
          <FileSignature className="w-4 h-4 text-[var(--text-muted)]" aria-hidden /> Согласие на материалы сайта
        </h3>
        {load.state === 'ok' && (
          <span className={`text-[11px] px-2 py-0.5 rounded-full border ${active ? 'text-[var(--success)] border-[var(--success)]' : 'text-[var(--text-muted)] border-[var(--border)]'}`}>
            {active ? `есть, от ${active.grantedOn}` : 'нет'}
          </span>
        )}
      </div>

      {load.state === 'loading' && (
        <p className="text-xs text-[var(--text-muted)] inline-flex items-center gap-1.5" role="status">
          <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> Читаем согласия…
        </p>
      )}
      {load.state === 'failed' && <p className="text-xs text-[var(--warning)]" role="alert">{load.message}</p>}

      {load.state === 'ok' && active && (
        <div className="text-xs text-[var(--text-secondary)] space-y-1" data-testid="consent-active">
          <p>Подписал: {active.signerName}, {active.signerRole}. Текст версии {active.textVersion}.</p>
          <p>Материалы: {MATERIAL_KINDS.filter((k) => active.materials.includes(k)).map((k) => MATERIAL_WORDS[k]).join(', ')}.</p>
          <p>Где: {CONSENT_SURFACES.filter((x) => active.surfaces.includes(x)).map((x) => SURFACE_SHORT[x]).join(', ')}.</p>
          {active.sites.length > 0 && <p>Сайты: {active.sites.map(siteWords).join(', ')}.</p>}
        </div>
      )}
      {load.state === 'ok' && !active && (
        <p className="text-xs text-[var(--text-secondary)]">
          Согласие не записано. Материалы с сайта партнёра показываются без его подписи — пошлите ему ссылку.
        </p>
      )}
      {load.state === 'ok' && load.invite && !load.invite.usedAt && !issued && (
        <p className="text-[11px] text-[var(--text-muted)]">Ссылка выпущена {load.invite.issuedAt.slice(0, 10)}, действует до {load.invite.expiresAt.slice(0, 10)}, ещё не подписана.</p>
      )}

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => void issue()} disabled={busy}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--border)] text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-50">
          <Link2 className="w-3.5 h-3.5" aria-hidden /> {load.state === 'ok' && load.invite ? 'Новая ссылка на согласие' : 'Ссылка на согласие'}
        </button>
        {active && !revoking && (
          <button type="button" onClick={() => setRevoking(true)} disabled={busy}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--border)] text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-50">
            <XCircle className="w-3.5 h-3.5" aria-hidden /> Отозвать
          </button>
        )}
      </div>

      {issued && (
        <div className="space-y-1.5">
          <textarea readOnly value={issued.text} rows={5} aria-label="Текст для партнёра со ссылкой"
            className="w-full px-3 py-1.5 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg text-xs text-[var(--text-primary)]" />
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => void copy(issued.text)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--border)] text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)]">
              {copied ? <Check className="w-3.5 h-3.5 text-[var(--success)]" aria-hidden /> : <Copy className="w-3.5 h-3.5" aria-hidden />}
              {copied ? 'Скопировано' : 'Скопировать текст'}
            </button>
            <span className="text-[11px] text-[var(--text-muted)]">Ссылка показана один раз, действует до {issued.expiresAt.slice(0, 10)}. Прежняя погашена.</span>
          </div>
        </div>
      )}

      {revoking && (
        <div className="space-y-1.5">
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Чьи слова и когда: «написал в MAX 25.10, просит снять фото»"
            aria-label="Причина отзыва"
            className="w-full px-3 py-1.5 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg text-xs text-[var(--text-primary)] placeholder-[var(--text-muted)]" />
          <div className="flex gap-2">
            <button type="button" onClick={() => void revoke()} disabled={busy || reason.trim().length < 8}
              className="px-3 py-1.5 rounded-lg border border-[var(--danger)] text-xs text-[var(--danger)] disabled:opacity-50">Записать отзыв</button>
            <button type="button" onClick={() => { setRevoking(false); setReason(''); }}
              className="px-3 py-1.5 rounded-lg border border-[var(--border)] text-xs text-[var(--text-secondary)]">Отмена</button>
          </div>
        </div>
      )}

      {error && <p className="text-xs text-[var(--danger)]" role="alert">{error}</p>}
      <p className="text-[11px] text-[var(--text-muted)]">{SURFACE_WORDS.own_page[0]?.toUpperCase()}{SURFACE_WORDS.own_page.slice(1)} входит в согласие всегда; остальное партнёр отмечает сам.</p>
    </section>
  );
}
