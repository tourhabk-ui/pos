'use client';

/**
 * Отметка «тестовый профиль» в карточке партнёра у администратора (1495,
 * #2770 часть 2). Кнопка верит ответу сервера, а не своему нажатию: отказ не
 * выглядит сохранённой отметкой (урок тумблера виджета 15.10). После ответа
 * сказано, что стало с витриной, — словами двери (`message`).
 */
import { useState } from 'react';
import { FlaskConical } from 'lucide-react';

export function TestProfileToggle({ partnerId, initial, onChange }: {
  partnerId: string;
  initial: boolean;
  onChange?: (isTest: boolean) => void;
}) {
  const [isTest, setIsTest] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  async function toggle() {
    if (saving) return;
    const next = !isTest;
    setSaving(true);
    setNote(null);
    try {
      const res = await fetch(`/api/admin/operators/${partnerId}/test-profile`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_test: next }),
      });
      const json: unknown = await res.json().catch(() => null);
      const body = typeof json === 'object' && json !== null ? json as Record<string, unknown> : {};
      const data = typeof body.data === 'object' && body.data !== null ? body.data as Record<string, unknown> : {};
      if (!res.ok || typeof data.is_test !== 'boolean') {
        const why = typeof body.error === 'string' ? body.error : `сервер ответил ${res.status}`;
        setNote({ ok: false, text: `Отметка не сохранена: ${why}` });
        return;
      }
      setIsTest(data.is_test);
      onChange?.(data.is_test);
      if (typeof body.message === 'string') setNote({ ok: true, text: body.message });
    } catch {
      setNote({ ok: false, text: 'Отметка не сохранена: нет связи с сервером' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => { void toggle(); }}
        disabled={saving}
        aria-pressed={isTest}
        className="inline-flex items-center gap-2 min-h-11 px-3 rounded-lg border border-[var(--border)] text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-60"
      >
        <FlaskConical className="w-4 h-4 text-[var(--text-muted)]" />
        {saving
          ? 'Сохранение…'
          : isTest
            ? 'Тестовый профиль — снять отметку'
            : 'Отметить тестовым профилем'}
      </button>
      <p className="mt-1 text-xs text-[var(--text-muted)]">
        Тестовый профиль не на витрине: ни карточки, ни туров в каталоге, поиске, плане, ответах Кузьмича и MCP.
      </p>
      {note && (
        <p role={note.ok ? 'status' : 'alert'} className={`mt-1 text-xs ${note.ok ? 'text-[var(--text-secondary)]' : 'text-[var(--danger)]'}`}>
          {note.text}
        </p>
      )}
    </div>
  );
}
