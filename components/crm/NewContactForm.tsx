'use client';

/**
 * Клиент, заведённый руками: позвонил, пришёл по знакомству (CRM #2325).
 * Согласие на обработку данных такая запись не несёт — его никто не собирал,
 * и форма об этом говорит, а не ставит галочку за клиента.
 */
import { useRef, useState, type FormEvent } from 'react';
import { X } from 'lucide-react';
import { useModalDialog } from '@/hooks/use-modal-dialog';
import { CRM_API } from './api';

interface Props {
  onClose: () => void;
  onCreated: (id: string) => void;
  /** Такой клиент уже есть — открыть его, а не заводить второго. */
  onExisting: (id: string) => void;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export function NewContactForm({ onClose, onCreated, onExisting }: Props) {
  const dialogRef = useRef<HTMLFormElement>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [notes, setNotes] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existingId, setExistingId] = useState<string | null>(null);

  useModalDialog(dialogRef, onClose, () => !sending);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setError('Укажите имя'); return; }
    setSending(true);
    setError(null);
    setExistingId(null);
    try {
      const res = await fetch(CRM_API.partner, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          display_name: name.trim(),
          phone: phone.trim() || null,
          email: email.trim() || null,
          notes: notes.trim() || null,
        }),
      });
      const json: unknown = await res.json().catch(() => null);
      const data = isRecord(json) && isRecord(json.data) ? json.data : null;
      if (res.status === 201 && data && typeof data.id === 'string') {
        onCreated(data.id);
        return;
      }
      if (res.status === 409 && data && typeof data.id === 'string') setExistingId(data.id);
      setError(isRecord(json) && typeof json.error === 'string' ? json.error : 'Не удалось сохранить клиента, попробуйте позже');
    } catch {
      setError('Нет связи с сервером — клиент не сохранён');
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4"
      role="presentation"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !sending) onClose(); }}
    >
      <form
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="crm-new-contact-title"
        onSubmit={submit}
        className="ds-card w-full sm:max-w-md max-h-[92dvh] overflow-y-auto rounded-t-lg sm:rounded-lg p-5 space-y-4 outline-none"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id="crm-new-contact-title" className="ds-h2 text-[var(--text-primary)]">Новый клиент</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={sending}
            aria-label="Закрыть"
            className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors duration-200 disabled:opacity-40"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-1">
          <label className="ds-label" htmlFor="crm-new-name">Имя</label>
          <input id="crm-new-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required className="ds-input w-full" />
        </div>
        <div className="space-y-1">
          <label className="ds-label" htmlFor="crm-new-phone">Телефон</label>
          <input id="crm-new-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={40} placeholder="+7 914 000-00-00" className="ds-input w-full" />
        </div>
        <div className="space-y-1">
          <label className="ds-label" htmlFor="crm-new-email">Почта</label>
          <input id="crm-new-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={200} className="ds-input w-full" />
        </div>
        <div className="space-y-1">
          <label className="ds-label" htmlFor="crm-new-notes">Заметка</label>
          <textarea id="crm-new-notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={5000} rows={3} className="ds-input w-full" />
        </div>

        <p className="text-xs text-[var(--text-muted)]">
          Согласие на обработку данных у такого клиента не записано: форма его не собирает. Если будете писать клиенту рассылки — спросите согласие сами.
        </p>

        {error && (
          <div className="text-sm text-[var(--danger)] space-y-2" role="alert">
            <p>{error}</p>
            {existingId && (
              <button type="button" onClick={() => onExisting(existingId)} className="ds-btn ds-btn-secondary">
                Открыть этого клиента
              </button>
            )}
          </div>
        )}

        <button type="submit" disabled={sending} className="ds-btn ds-btn-primary w-full">
          {sending ? 'Сохраняю…' : 'Добавить клиента'}
        </button>
      </form>
    </div>
  );
}
