'use client';

/**
 * Подтверждение изменения цен, подготовленного Кузьмичом (K.ai B3).
 * Показывает сохранённый на сервере предпросмотр; применяет кнопкой.
 * Вход — обязателен (layout кабинета), право цен проверяет сервер.
 */
import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';

interface Tour { tourId: number; title: string; baseBefore: number; baseAfter: number; saturdayBefore: number; saturdayAfter: number; tiersOverride: boolean }
interface Data { state: 'open' | 'used' | 'expired'; expiresAt: string; change: { kind: string; percent: number | null }; preview: { sampleDate: string; tours: Tour[] } }
const rub = (n: number) => `${n.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;

export default function ConfirmClient() {
  const id = useSearchParams().get('id') ?? '';
  const [data, setData] = useState<Data | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`/api/hub/operator/price-changes/${encodeURIComponent(id)}`, { cache: 'no-store' })
      .then(async (r) => { const j = await r.json().catch(() => null); if (r.ok && j?.success) setData(j.data); else setMsg(j?.error ?? 'Изменение не найдено'); });
  }, [id]);

  async function confirm() {
    setBusy(true);
    const r = await fetch(`/api/hub/operator/price-changes/${encodeURIComponent(id)}`, { method: 'POST' });
    const j = await r.json().catch(() => null);
    setBusy(false);
    if (!r.ok || !j?.success) { setMsg(j?.error ?? 'Не удалось применить'); return; }
    const skipped = j.data.skipped.length;
    setMsg(`Готово: изменено туров — ${j.data.applied.length}.${skipped ? ` Пропущено ${skipped}: цена менялась после предпросмотра.` : ''}`);
    setData((d) => (d ? { ...d, state: 'used' } : d));
  }

  if (!data) return <div className="p-6">{msg ?? 'Загрузка…'}</div>;
  const c = data.change;
  const head = c.kind === 'weekend_markup'
    ? (c.percent === null ? 'Снять наценку на выходные (сб, вс)' : `Наценка на выходные (сб, вс): +${c.percent}%`)
    : `Базовая цена: ${(c.percent ?? 0) > 0 ? '+' : '−'}${Math.abs(c.percent ?? 0)}%`;
  return (
    <div className="p-6 space-y-4 max-w-3xl">
      <h1 className="text-xl font-semibold">{head}</h1>
      <table className="w-full text-sm">
        <thead><tr><th className="text-left">Тур</th><th>База</th><th>Сб {data.preview.sampleDate.slice(8, 10)}.{data.preview.sampleDate.slice(5, 7)}, за одного</th></tr></thead>
        <tbody>{data.preview.tours.map((t) => (
          <tr key={t.tourId}>
            <td>{t.title}{t.tiersOverride ? ' — цены по размеру группы' : ''}</td>
            <td>{rub(t.baseBefore)}{t.baseAfter !== t.baseBefore ? ` → ${rub(t.baseAfter)}` : ''}</td>
            <td>{rub(t.saturdayBefore)} → {rub(t.saturdayAfter)}</td>
          </tr>))}</tbody>
      </table>
      <p className="text-sm text-[var(--text-muted)]">Уже оформленные брони не меняются. Ссылка одноразовая, действует 24 часа.</p>
      {msg && <p>{msg}</p>}
      {data.state === 'open'
        ? <button className="ds-btn" disabled={busy} onClick={confirm}>Подтвердить изменение</button>
        : !msg && <p>{data.state === 'used' ? 'Это изменение уже подтверждено.' : 'Ссылка истекла. Попросите Кузьмича ещё раз.'}</p>}
    </div>
  );
}
