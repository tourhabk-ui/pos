'use client';

/**
 * Ключи Tilda API партнёра — живут у записи партнёра в базе, не в env
 * (решение владельца 06.08: «он же будет не один»). Секрет после сохранения
 * виден только маской; проверка ключей — живым запросом списка страниц.
 *
 * ОДИН компонент на обе админки партнёров («Операторы» и «Управление
 * партнёрами») — владелец работает из любой, а расходящиеся копии одного
 * блока платформа уже проходила (#887, карточка тура).
 */

import { useEffect, useState } from 'react';
import { KeyRound, Loader2, Check, Globe } from 'lucide-react';

export default function TildaPanel({ operatorId }: { operatorId: string }) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [masked, setMasked] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [publicKey, setPublicKey] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/admin/operators/${operatorId}/integrations/tilda`)
      .then(r => r.ok ? r.json() : null)
      .then((j: unknown) => {
        if (j && typeof j === 'object' && 'configured' in j) {
          const d = j as { configured: boolean; public_key_masked: string | null };
          setConfigured(d.configured);
          setMasked(d.public_key_masked);
        }
      })
      .catch(() => {});
  }, [operatorId]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/operators/${operatorId}/integrations/tilda`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ public_key: publicKey.trim(), secret_key: secretKey.trim() }),
      });
      const j = await res.json() as { error?: string; public_key_masked?: string };
      if (!res.ok) {
        setError(j.error ?? 'Не удалось сохранить');
        return;
      }
      setConfigured(true);
      setMasked(j.public_key_masked ?? null);
      setEditing(false);
      setPublicKey('');
      setSecretKey('');
    } catch {
      setError('Сеть недоступна');
    } finally {
      setSaving(false);
    }
  }

  async function checkPages() {
    setChecking(true);
    setCheckResult(null);
    try {
      const res = await fetch(`/api/admin/operators/${operatorId}/tilda/pages`);
      const j = await res.json() as {
        error?: string;
        projects?: { title: string; pages_total: number; pages: { title: string; alias?: string; published?: string }[] }[];
      };
      if (!res.ok) {
        setCheckResult(`Ошибка: ${j.error ?? 'нет ответа'}`);
        return;
      }
      const lines = (j.projects ?? []).map(p => {
        const titles = p.pages.slice(0, 8).map(pg => pg.title).join(' · ');
        return `${p.title}: ${p.pages_total} стр. — ${titles}${p.pages_total > 8 ? ' …' : ''}`;
      });
      setCheckResult(lines.join('\n') || 'Проектов не найдено');
    } catch {
      setCheckResult('Ошибка: сеть недоступна');
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="mt-3 border-t border-[var(--border)] pt-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5 text-sm font-medium text-[var(--text-secondary)]">
          <KeyRound className="w-3.5 h-3.5 text-[var(--text-muted)]" />
          Tilda API партнёра
        </div>
        {configured !== null && !editing && (
          <button
            onClick={() => setEditing(true)}
            className={`px-3 py-1 text-xs rounded-full font-medium transition-colors ${
              configured
                ? 'bg-[var(--success)]/15 text-[var(--success)]'
                : 'bg-[var(--bg-primary)] text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
            }`}
          >
            {configured ? `Ключи заданы (${masked ?? '····'})` : 'Добавить ключи'}
          </button>
        )}
      </div>

      {editing && (
        <div className="flex flex-col gap-1.5 mb-2">
          <input
            value={publicKey}
            onChange={e => setPublicKey(e.target.value)}
            placeholder="Public key (Настройки сайта → Экспорт → API)"
            autoComplete="off"
            className="px-2 py-1.5 text-xs bg-[var(--bg-primary)] border border-[var(--accent)] rounded text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none"
          />
          <input
            value={secretKey}
            onChange={e => setSecretKey(e.target.value)}
            placeholder="Secret key"
            type="password"
            autoComplete="off"
            className="px-2 py-1.5 text-xs bg-[var(--bg-primary)] border border-[var(--accent)] rounded text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none"
          />
          {error && <p className="text-xs text-[var(--danger)]">{error}</p>}
          <div className="flex gap-1.5">
            <button
              onClick={save}
              disabled={saving || !publicKey.trim() || !secretKey.trim()}
              className="flex items-center gap-1 px-2 py-1 text-xs bg-[var(--accent)] text-white rounded hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
              Сохранить
            </button>
            <button
              onClick={() => { setEditing(false); setError(null); }}
              className="px-2 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
            >
              Отмена
            </button>
          </div>
          <p className="text-[10px] text-[var(--text-muted)]">
            Секрет хранится в базе у партнёра и после сохранения показывается только маской.
          </p>
        </div>
      )}

      {configured && !editing && (
        <div>
          <button
            onClick={checkPages}
            disabled={checking}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-[var(--ocean)]/10 text-[var(--ocean)] border border-[var(--ocean)]/20 rounded-lg hover:bg-[var(--ocean)]/20 transition-colors disabled:opacity-50"
          >
            {checking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Globe className="w-3.5 h-3.5" />}
            Страницы сайта через API
          </button>
          {checkResult && (
            <pre className="mt-2 max-h-32 overflow-y-auto text-[10px] text-[var(--text-secondary)] whitespace-pre-wrap bg-[var(--bg-primary)] rounded p-2">
              {checkResult}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
