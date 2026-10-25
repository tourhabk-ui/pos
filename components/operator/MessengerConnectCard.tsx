'use client';

import { ExternalLink, Loader2, Send } from 'lucide-react';

export interface MessengerCodeView {
  loading: boolean;
  error: string | null;
  code: string | null;
  telegramUrl: string | null;
  maxUrl: string | null;
  telegramQr: string | null;
  maxQr: string | null;
}

export function MessengerConnectCard(props: {
  status: 'connected' | 'not_connected' | 'unknown';
  panel: MessengerCodeView | null;
  onIssue: () => void;
}) {
  const { status, panel, onIssue } = props;
  const statusClass = status === 'connected'
    ? 'text-[var(--success)]'
    : status === 'not_connected'
      ? 'text-[var(--warning)]'
      : 'text-[var(--text-muted)]';
  const statusText = status === 'connected'
    ? 'Подключены'
    : status === 'not_connected'
      ? 'Не подключены'
      : 'Статус неизвестен — не удалось проверить';

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-6 space-y-3">
      <div className="flex items-center gap-2">
        <Send className="w-5 h-5 text-[var(--ocean)]" />
        <h2 className="text-base font-semibold text-[var(--text-primary)]">Заявки в Telegram и MAX</h2>
      </div>
      <p className={`text-sm font-medium ${statusClass}`}>{statusText}</p>
      <p className="text-sm text-[var(--text-secondary)]">
        Код из шести знаков привязывает этот кабинет туроператора. Роль человека в аккаунте
        здесь не читается. Код действует 30 минут. В боте отправьте <span className="font-medium">/start</span> и код.
        Поле «Telegram для клиентов» выше — контакт для туристов, уведомления туда не приходят.
      </p>
      {panel?.code && (
        <div className="space-y-3">
          <p className="text-2xl font-semibold tracking-widest text-[var(--text-primary)]">/start {panel.code}</p>
          <div className="flex flex-wrap gap-4">
            {panel.telegramQr && (
              <figure className="space-y-2">
                {/* data URL: next/image его не отдаёт, оптимизировать нечего */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={panel.telegramQr} alt="QR-код для Telegram" width={180} height={180} className="rounded-lg border border-[var(--border)]" />
                <figcaption className="text-sm text-[var(--text-muted)]">Telegram</figcaption>
              </figure>
            )}
            {panel.maxQr && (
              <figure className="space-y-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={panel.maxQr} alt="QR-код для MAX" width={180} height={180} className="rounded-lg border border-[var(--border)]" />
                <figcaption className="text-sm text-[var(--text-muted)]">MAX</figcaption>
              </figure>
            )}
          </div>
          {!panel.telegramQr && !panel.maxQr && (
            <p className="text-sm text-[var(--text-muted)]">QR не собрался. Откройте бота кнопкой и отправьте код вручную.</p>
          )}
          <div className="flex flex-wrap gap-2">
            {panel.telegramUrl && (
              <a href={panel.telegramUrl} target="_blank" rel="noopener noreferrer" className="ds-btn ds-btn-primary inline-flex items-center gap-2 min-h-[44px] px-4">
                Открыть Telegram
                <ExternalLink className="w-4 h-4" />
              </a>
            )}
            {panel.maxUrl && (
              <a href={panel.maxUrl} target="_blank" rel="noopener noreferrer" className="ds-btn ds-btn-secondary inline-flex items-center gap-2 min-h-[44px] px-4">
                Открыть MAX
                <ExternalLink className="w-4 h-4" />
              </a>
            )}
          </div>
        </div>
      )}
      {panel?.error && (
        <p className="text-sm text-[var(--danger)]">{panel.error}</p>
      )}
      <button
        type="button"
        onClick={onIssue}
        disabled={panel?.loading === true}
        className="ds-btn ds-btn-secondary inline-flex items-center gap-2 min-h-[44px] px-4"
      >
        {panel?.loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
        {panel?.code ? 'Получить новый' : status === 'connected' ? 'Подключить другой чат' : 'Получить код'}
      </button>
    </div>
  );
}
