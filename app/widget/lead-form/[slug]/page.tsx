'use client';

/**
 * Форма заявки партнёру в виджете (iframe из lead.js на сайте партнёра или из
 * окна чата `/widget/<slug>`).
 *
 * Аудит 15.10, WID-lang: строки формы — на языке браузера посетителя (ru, en,
 * zh) из словаря lib/embed/widget-i18n. Вступление партнёра (`formIntro`) не
 * переводится. Согласие на ПД — юридический текст со своей версией: оно
 * остаётся русским (тот же PdConsentCheckbox и та же версия), а на en/zh под
 * ним пометка на языке посетителя, что согласие на русском, и ссылка на
 * политику. Машинный перевод согласия был бы вторым текстом без версии.
 *
 * Сторожа: tests/unit/widget-lang.test.tsx, tests/unit/mestechko-widget.test.ts
 * (рендер).
 */

import { useState, useEffect, useRef } from 'react';
import { useParams } from 'next/navigation';
import { PdConsentCheckbox } from '@/components/legal/PdConsentCheckbox';
import { PD_CONSENT_POLICY_URL } from '@/lib/legal/pd-consent';
import { readWidgetOriginParams } from '@/lib/embed/widget-origin';
import { widgetFormIntro, widgetTexts } from '@/lib/embed/widget-i18n';
import { useWidgetLang } from '@/hooks/use-widget-lang';
import { logSwallowedFailure } from '@/lib/observability/swallowed';

interface PartnerConfig {
  name: string;
  /** Вступление ФОРМЫ (`widget_config.formIntro` или нейтральное), не приветствие чата. */
  formIntro?: string;
  accentColor: string;
  logo: string | null;
}

export default function LeadFormPage() {
  const params = useParams();
  const slug = params.slug as string;
  const lang = useWidgetLang();
  const t = widgetTexts(lang);

  const [config, setConfig] = useState<PartnerConfig | null>(null);
  const [name, setName]       = useState('');
  const [phone, setPhone]     = useState('');
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError]     = useState('');
  const [pdConsent, setPdConsent] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Высоту окна задаёт форма, а не угадывает lead.js. До 29.09 iframe стоял
  // 440 px со scrolling="no", а форма занимала 537 px: «Отправить заявку»
  // была за краем, отправить кликом было нельзя (примерка на fishingkam.ru).
  // Документ формы сообщает свою высоту, lead.js подгоняет под неё iframe.
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof window === 'undefined' || window.parent === window) return;
    const post = () => {
      window.parent.postMessage({ type: 'th:height', height: Math.ceil(el.scrollHeight) }, '*');
    };
    post();
    // Старые браузеры без ResizeObserver: высота отправлена один раз, а
    // окно всё равно прокручивается — форма не падает целиком.
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(post);
    ro.observe(el);
    return () => ro.disconnect();
  }, [success]);

  // Esc внутри iframe не доходит до страницы партнёра — закрываем сами.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && window.parent !== window) window.parent.postMessage('th:close', '*');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Настройки партнёра — оформление (имя, логотип, цвет, вступление). Не
  // загрузились — форма работает с нейтральным текстом и отправляет заявку на
  // slug, но отказ называется в консоли, а не глушится (§4.0; аудит 15.10,
  // W3-widget: до этого здесь стоял пустой .catch). ПД в строке нет — только
  // slug партнёра и причина.
  useEffect(() => {
    if (!slug) return;
    fetch(`/api/widget/partner/${slug}`)
      .then(r => r.json())
      .then(d => {
        if (d.success && d.data) setConfig(d.data);
      })
      .catch((err: unknown) => {
        logSwallowedFailure('widget-lead-form', `запрос настроек партнёра ${slug}`, err);
      });
  }, [slug]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    if (!pdConsent) { setError(t.consentRequired); return; }
    setError('');
    setSubmitting(true);
    try {
      const res = await fetch('/api/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          phone: phone.trim(),
          comment: comment.trim() || undefined,
          // На верхнем уровне: /api/leads ищет оператора ИМЕННО здесь. До
          // 29.09 slug жил только в source_data, лид вставал без оператора,
          // уходил в общий пул и в рабочий чат платформы, а не партнёру.
          partner_slug: slug,
          source_data: {
            source:       'partner_widget',
            partner_slug: slug,
            // Хост и путь страницы партнёра — из адреса этого окна: их кладёт
            // lead.js, а у формы, открытой из окна чата, — окно чата
            // (leadFormPath). Запасом — адрес чата из document.referrer. Исход
            // сверки со списком доменов ставит сервер; хост подделывается —
            // сигнал, а не замок (аудит 15.10, WID-measure, W3-widget).
            widget_origin: readWidgetOriginParams(
              window.location.search, document.referrer, window.location.origin,
            ),
          },
          pd_consent: true,
        }),
      });
      const data: unknown = await res.json();
      if (res.ok && (data as { success?: boolean }).success) {
        setSuccess(true);
        if (typeof window !== 'undefined') {
          window.parent.postMessage('th:success', '*');
        }
      } else {
        // Ответ /api/leads — по-русски: на русском окне он и показывается, на
        // en/zh — отказ на языке посетителя (русская строка ему ничего не скажет).
        const serverError = (data as { error?: string }).error;
        setError(lang === 'ru' && serverError ? serverError : t.submitFailed);
      }
    } catch {
      setError(t.networkFailed);
    } finally {
      setSubmitting(false);
    }
  }

  const accent = config?.accentColor ?? 'var(--accent)';

  if (success) {
    return (
      <div ref={rootRef} lang={lang} style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '32px 24px',
        fontFamily: "'Outfit', system-ui, sans-serif",
        background: 'var(--bg-primary)',
        textAlign: 'center',
      }}>
        <div style={{
          width: 56,
          height: 56,
          borderRadius: '50%',
          background: 'var(--success)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 16,
          fontSize: 24,
        }}>
          ✓
        </div>
        <p style={{ fontWeight: 700, fontSize: 18, color: 'var(--text-primary)', marginBottom: 8 }}>
          {t.successTitle}
        </p>
        <p style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          {t.successText}
        </p>
        <button
          onClick={() => window.parent.postMessage('th:close', '*')}
          style={{
            marginTop: 24,
            padding: '10px 24px',
            background: accent,
            color: 'white',
            border: 'none',
            borderRadius: 24,
            fontSize: 14,
            fontWeight: 600,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          {t.close}
        </button>
      </div>
    );
  }

  return (
    <div ref={rootRef} lang={lang} style={{
      display: 'flex',
      flexDirection: 'column',
      fontFamily: "'Outfit', system-ui, sans-serif",
      background: 'var(--bg-primary)',
    }}>
      {/* Header */}
      <div style={{
        padding: '16px 20px',
        background: 'var(--bg-card)',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}>
        {config?.logo && (
          <img
            src={config.logo}
            alt={config.name}
            style={{ width: 28, height: 28, borderRadius: 6, objectFit: 'cover' }}
          />
        )}
        <div>
          <p style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)', lineHeight: 1.2 }}>
            {config?.name ?? t.formTitleFallback}
          </p>
          <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {t.brand}
          </p>
        </div>
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} style={{ padding: '20px', flex: 1, display: 'flex', flexDirection: 'column' }}>
        {/* Вступление формы, а не приветствие чата: до 15.10 здесь стояло
            config.greeting, и над полями имени и телефона у «Местечка» было
            «Я Кузьмич… спрашивайте» (находка аудита 15.10 WID-config). */}
        <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 20, lineHeight: 1.5 }}>
          {widgetFormIntro(lang, config?.formIntro)}
        </p>

        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>
          {t.nameLabel}
        </label>
        <input
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder={t.namePlaceholder}
          required
          minLength={2}
          maxLength={120}
          style={inputStyle}
        />

        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4, marginTop: 14, display: 'block' }}>
          {t.phoneLabel}
        </label>
        <input
          type="tel"
          value={phone}
          onChange={e => setPhone(e.target.value)}
          placeholder={t.phonePlaceholder}
          required
          minLength={7}
          maxLength={30}
          style={inputStyle}
        />

        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4, marginTop: 14, display: 'block' }}>
          {t.commentLabel}
        </label>
        <textarea
          value={comment}
          onChange={e => setComment(e.target.value)}
          placeholder={t.commentPlaceholder}
          maxLength={500}
          rows={3}
          style={{ ...inputStyle, resize: 'none' }}
        />

        {error && (
          <p style={{ fontSize: 12, color: 'var(--danger)', marginTop: 10 }}>{error}</p>
        )}

        {/* Согласие — русский текст с его версией при любом языке окна:
            записывается версия, под которой человек согласился, и перевод
            без своей версии её бы не покрыл. lang="ru" — чтобы экранный
            диктор читал его по-русски и в китайском окне. */}
        <div lang="ru" style={{ marginTop: 12 }}>
          <PdConsentCheckbox checked={pdConsent} onChange={setPdConsent} id="pd-consent-widget" />
        </div>
        {t.consentNote && (
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4, lineHeight: 1.5 }}>
            {t.consentNote}{' '}
            <a
              href={PD_CONSENT_POLICY_URL}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'var(--ocean)' }}
            >
              {t.policyLink}
            </a>
          </p>
        )}

        <button
          type="submit"
          disabled={submitting || !name.trim() || !phone.trim() || !pdConsent}
          style={{
            marginTop: 16,
            padding: '12px 20px',
            background: submitting || !name.trim() || !phone.trim() || !pdConsent ? 'var(--bg-hover)' : accent,
            color: 'white',
            border: 'none',
            borderRadius: 10,
            fontSize: 14,
            fontWeight: 700,
            cursor: submitting ? 'not-allowed' : 'pointer',
            fontFamily: 'inherit',
            transition: 'background 0.15s',
          }}
        >
          {submitting ? t.submitting : t.submit}
        </button>
      </form>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: '10px 14px',
  border: '1px solid var(--border)',
  borderRadius: 8,
  fontSize: 14,
  fontFamily: "'Outfit', system-ui, sans-serif",
  color: 'var(--text-primary)',
  background: 'var(--bg-card)',
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
};
