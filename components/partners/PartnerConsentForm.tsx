'use client';

/**
 * Форма согласия партнёра на использование материалов его сайта (миграция
 * 1321, решение владельца 23.10). Доказательство — ключ одноразовой ссылки в
 * адресе (#…): сначала спрашиваем, чья это ссылка и годится ли она, потом
 * текст согласия, подпись и две галочки.
 *
 * Выбора «где показывать» и «какие материалы» нет (ревью 23.10): исполнить его
 * нечем, и галочка обещала бы то, чего платформа не делает. Текст один и
 * говорит, как Ведар использует материалы на самом деле. Его собирает та же
 * функция, что сервер (`consentDocument`), и страница отправляет его на
 * сверку: разошёлся с серверным — подписи нет, партнёр видит, что обновить.
 * Отправка неактивна и выглядит неактивной, пока чего-то не хватает, и
 * причина связана с кнопкой (тот же урок, что форма заявки на машину, 14.10).
 *
 * В запрос уходит СОСТОЯНИЕ галочек, а не литерал true (pd-consent-registry).
 */

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Loader2 } from 'lucide-react';
import { PdConsentCheckbox } from '@/components/legal/PdConsentCheckbox';
import {
  authorityStatement, consentDateWords, consentDocument, materialsConsentParagraphs, siteWords,
} from '@/lib/legal/partner-materials-consent';
import { PARTNER_CONSENT_PATH, isConsentKeyShape } from '@/lib/partners/material-consent-rules';

type Basis =
  | { kind: 'checking' }
  | { kind: 'link'; key: string; partnerName: string; sites: string[]; currentOn: string | null }
  | { kind: 'no_link' }
  | { kind: 'problem'; message: string };

type Sending = 'idle' | 'sending' | 'sent';

export function PartnerConsentForm() {
  const [basis, setBasis] = useState<Basis>({ kind: 'checking' });
  const [signerName, setSignerName] = useState('');
  const [signerRole, setSignerRole] = useState('');
  const [authority, setAuthority] = useState(false);
  const [pdConsent, setPdConsent] = useState(false);
  const [sending, setSending] = useState<Sending>('idle');
  const [error, setError] = useState<string | null>(null);
  const [grantedOn, setGrantedOn] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const key = window.location.hash.slice(1);
    (async () => {
      try {
        if (key && isConsentKeyShape(key)) {
          const res = await fetch('/api/partner-consent/invite', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key }),
          });
          const body = await res.json().catch(() => null) as
            | { success?: boolean; error?: string; data?: { state: string; message?: string; partner_name?: string; sites?: string[]; current?: { grantedOn?: string } | null } }
            | null;
          if (cancelled) return;
          if (!res.ok || !body?.success || !body.data) {
            setBasis({ kind: 'problem', message: body?.error ?? 'Не смогли проверить ссылку — попробуйте позже.' });
          } else if (body.data.state !== 'ok' || !body.data.partner_name) {
            setBasis({ kind: 'problem', message: body.data.message ?? 'Ссылка не годится.' });
          } else {
            setBasis({
              kind: 'link', key, partnerName: body.data.partner_name, sites: body.data.sites ?? [],
              currentOn: body.data.current?.grantedOn ?? null,
            });
          }
          return;
        }
        setBasis(key
          ? { kind: 'problem', message: 'Ссылка не распознана — откройте её из сообщения целиком.' }
          : { kind: 'no_link' });
      } catch {
        if (!cancelled) setBasis({ kind: 'problem', message: 'Нет связи с сервером. Проверьте подключение и обновите страницу.' });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const paragraphs = useMemo(() => (basis.kind === 'link'
    ? materialsConsentParagraphs({ partnerName: basis.partnerName, sites: basis.sites })
    : []), [basis]);

  const missing: string[] = [];
  if (signerName.trim().length < 2) missing.push('имя и фамилию');
  if (signerRole.trim().length < 2) missing.push('должность');
  if (!authority) missing.push('подтверждение полномочий');
  if (!pdConsent) missing.push('согласие на обработку имени и должности');
  const ready = missing.length === 0;

  async function submit() {
    if (basis.kind !== 'link' || !ready) return;
    setSending('sending');
    setError(null);
    try {
      const res = await fetch('/api/partner-consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: basis.key, signer_name: signerName, signer_role: signerRole,
          // Ровно тот текст, что на экране: сервер собирает свой и сверяет.
          text: consentDocument({ partnerName: basis.partnerName, sites: basis.sites }),
          authority, pd_consent: pdConsent,
        }),
      });
      const body = await res.json().catch(() => null) as { success?: boolean; error?: string; data?: { granted_on?: string } } | null;
      if (!res.ok || !body?.success) {
        setError(body?.error ?? 'Не удалось записать согласие. Попробуйте позже.');
        setSending('idle');
        return;
      }
      // Ключ погашен — убираем его из адресной строки, чтобы он не уехал дальше.
      window.history.replaceState(null, '', PARTNER_CONSENT_PATH);
      setGrantedOn(body.data?.granted_on ?? null);
      setSending('sent');
    } catch {
      setError('Нет связи с сервером. Согласие не записано.');
      setSending('idle');
    }
  }

  if (sending === 'sent' && basis.kind === 'link') {
    return (
      <div className="ds-card p-5" role="status">
        <p className="inline-flex items-center gap-2 text-[var(--success)] font-medium">
          <Check className="w-5 h-5" aria-hidden /> Спасибо — согласие записано{grantedOn ? ` ${consentDateWords(grantedOn)}` : ''}.
        </p>
        <p className="text-sm text-[var(--text-secondary)] mt-2">
          Ведар использует материалы «{basis.partnerName}» так, как сказано в тексте согласия. Отозвать его можно в любой
          момент — напишите менеджеру Ведара в MAX или Telegram.
        </p>
      </div>
    );
  }

  if (basis.kind === 'checking') {
    return (
      <p className="text-sm text-[var(--text-muted)] inline-flex items-center gap-2" role="status">
        <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> Проверяем ссылку…
      </p>
    );
  }

  if (basis.kind === 'problem') {
    return (
      <div className="ds-card p-5">
        <p className="text-sm text-[var(--text-secondary)] flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-[var(--warning)] shrink-0 mt-0.5" aria-hidden /> {basis.message}
        </p>
      </div>
    );
  }

  if (basis.kind === 'no_link') {
    return (
      <div className="ds-card p-5 space-y-2 text-sm text-[var(--text-secondary)]" data-testid="consent-no-link">
        <p>Согласие подписывается по личной ссылке, которую присылает менеджер Ведара в MAX или Telegram.</p>
        <p>Если вы партнёр Ведара и ссылки у вас нет — напишите менеджеру, он пришлёт.</p>
      </div>
    );
  }

  return (
    <form className="space-y-6" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <section className="ds-card p-5 space-y-2" aria-labelledby="consent-partner">
        <h2 id="consent-partner" className="font-playfair text-xl font-bold text-[var(--text-primary)]">{basis.partnerName}</h2>
        {basis.sites.length > 0 ? (
          <p className="text-sm text-[var(--text-secondary)]">Сайт: {basis.sites.map(siteWords).join(', ')}</p>
        ) : (
          <p className="text-sm text-[var(--text-secondary)]">Адрес сайта у нас не записан — согласие касается ваших сайтов и страниц.</p>
        )}
        {basis.currentOn && (
          <p className="text-xs text-[var(--text-muted)]">
            Действующее согласие от {consentDateWords(basis.currentOn)}. Новое заменит его.
          </p>
        )}
      </section>

      <section className="ds-card p-5 space-y-3" aria-labelledby="consent-text">
        <h2 id="consent-text" className="ds-label">Текст согласия</h2>
        {paragraphs.map((p, i) => (
          <p key={i} className="text-sm leading-relaxed text-[var(--text-primary)]">{p}</p>
        ))}
      </section>

      <div className="space-y-4">
        <label className="block">
          <span className="ds-label">Имя и фамилия</span>
          <input className="ds-input mt-1 w-full" value={signerName} onChange={(e) => setSignerName(e.target.value)}
            autoComplete="name" maxLength={120} />
        </label>
        <label className="block">
          <span className="ds-label">Должность или кем вы приходитесь партнёру</span>
          <input className="ds-input mt-1 w-full" value={signerRole} onChange={(e) => setSignerRole(e.target.value)}
            autoComplete="organization-title" placeholder="Например: владелец, директор, менеджер" maxLength={120} />
        </label>
        <label htmlFor="consent-authority" className="flex items-start gap-3 min-h-[44px] py-2 cursor-pointer text-xs leading-relaxed text-[var(--text-secondary)]">
          <input id="consent-authority" type="checkbox" className="w-5 h-5 shrink-0 accent-[var(--accent)]"
            checked={authority} onChange={(e) => setAuthority(e.target.checked)} />
          <span>{authorityStatement(basis.partnerName)}</span>
        </label>
        <PdConsentCheckbox id="consent-pd" checked={pdConsent} onChange={setPdConsent} purpose="partner-signer" />
      </div>

      {error && (
        <p className="text-sm text-[var(--danger)]" role="alert">{error}</p>
      )}

      <div>
        {/* Неактивная — и выглядит неактивной, причина связана с кнопкой
            (ревью 23.10; тот же урок, что форма заявки на машину, 14.10). */}
        <button type="submit"
          className="ds-btn ds-btn-primary w-full sm:w-auto disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={!ready || sending === 'sending'}
          aria-describedby={ready ? undefined : 'consent-missing'}>
          {sending === 'sending' ? 'Записываем…' : 'Подписать согласие'}
        </button>
        {!ready && (
          <p id="consent-missing" className="text-sm text-[var(--text-secondary)] mt-2">
            Чтобы подписать, осталось: {missing.join(', ')}.
          </p>
        )}
      </div>
    </form>
  );
}
