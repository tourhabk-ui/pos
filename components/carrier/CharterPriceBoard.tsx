'use client';

/**
 * Прайс перевозчика в кабинете на сайте (#2862 этап C, миграция 1355).
 *
 * Живая строка меняется только одобрением администратора: здесь перевозчик
 * пишет ЧЕРНОВИК — правку строки (цена, примечание, условия, показывать ли
 * на сайте) или новую строку. Что на сайте, что в черновике и что решено —
 * видно рядом; причина отказа — его словами, не «отклонено».
 *
 * Три исхода чтения (§4.0): читаем / есть / не прочиталось — у прайса и у
 * черновиков отдельно. Записи — только через /api/hub/carrier/prices.
 */
import { useState } from 'react';
import { AlertCircle, Pencil, Plus } from 'lucide-react';
import { formatRub } from '@/lib/transfers/charter-format';
import {
  CHARTER_LINE_KINDS, CHARTER_VEHICLE_KINDS, LINE_KIND_LABEL, VEHICLE_KIND_LABEL, priceRowLabel,
  type CharterLineKind, type CharterPriceRow,
} from '@/lib/transfers/price-edit';
import type { OwnDraft } from '@/lib/transfers/price-edit-store';
import type { CharterVehicleKind } from '@/lib/transfers/charter-format';

export const CARRIER_PRICES_API = '/api/hub/carrier/prices';

export type BoardLoad<T> = { state: 'loading' } | { state: 'ok'; items: T[] } | { state: 'failed'; message: string };

interface CharterPriceBoardProps {
  rows: BoardLoad<CharterPriceRow>;
  drafts: BoardLoad<OwnDraft>;
  /** После записи черновика — перечитать прайс и черновики. */
  onChanged: () => void;
  say: (kind: 'ok' | 'err', text: string) => void;
}

async function postJson(body: unknown): Promise<{ ok: boolean; message?: string; error?: string }> {
  try {
    const res = await fetch(CARRIER_PRICES_API, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as { success?: boolean; message?: string; error?: string } | null;
    if (!res.ok || !json?.success) return { ok: false, error: json?.error ?? `Ошибка ${res.status}` };
    return { ok: true, message: json.message };
  } catch {
    return { ok: false, error: 'нет связи с сервером' };
  }
}

function whenRu(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

/** Что просит черновик — словами, для строки под живой ценой. */
export function draftWords(d: Pick<OwnDraft, 'priceRub' | 'priceNote' | 'conditions' | 'isActive'>): string {
  const bits: string[] = [];
  if (d.priceRub !== null) bits.push(`цена ${formatRub(d.priceRub)}`);
  if (d.priceNote !== null) bits.push(`примечание «${d.priceNote}»`);
  if (d.conditions !== null) bits.push(`условия «${d.conditions}»`);
  if (d.isActive === false) bits.push('скрыть с сайта');
  if (d.isActive === true) bits.push('показать на сайте');
  return bits.join(', ');
}

const STATUS_WORD: Record<OwnDraft['status'], string> = {
  pending: 'на модерации',
  approved: 'одобрено',
  rejected: 'отклонено',
};

export function CharterPriceBoard({ rows, drafts, onChanged, say }: CharterPriceBoardProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const draftList = drafts.state === 'ok' ? drafts.items : [];
  const pendingByRow = new Map(draftList.filter((d) => d.status === 'pending' && d.priceId).map((d) => [d.priceId as string, d]));
  const decided = draftList.filter((d) => d.status !== 'pending');
  const newPending = draftList.filter((d) => d.status === 'pending' && !d.priceId);

  return (
    <section data-testid="charter-price-board">
      <p className="text-xs text-[var(--text-secondary)] mb-3">
        Правка прайса — черновик: на сайте остаётся прежняя строка, пока её не одобрит администратор Ведара. Цена — за машину целиком.
      </p>

      {rows.state === 'loading' && <p className="text-sm text-[var(--text-muted)]">Читаем прайс…</p>}
      {rows.state === 'failed' && (
        <div className="ds-card p-4 flex items-start gap-2 border-[var(--warning)]">
          <AlertCircle size={16} className="text-[var(--warning)] shrink-0 mt-0.5" />
          <p className="text-sm text-[var(--text-secondary)]">Не смогли прочитать прайс: {rows.message}. Это не значит, что его нет.</p>
        </div>
      )}
      {rows.state === 'ok' && rows.items.length === 0 && (
        <p className="text-sm text-[var(--text-secondary)] mb-3">Строк прайса пока нет. Без прайса перевозчика на витрине нет — добавьте первую строку.</p>
      )}
      {rows.state === 'ok' && rows.items.length > 0 && (
        <ul className="flex flex-col gap-2 mb-4">
          {rows.items.map((row) => {
            const pending = pendingByRow.get(row.id);
            return (
              <li key={row.id} className="ds-card p-3" data-testid="price-row">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-[var(--text-primary)]">{priceRowLabel(row)}</p>
                    <p className="text-xs text-[var(--text-secondary)]">
                      {formatRub(row.priceRub)} за машину{row.priceNote ? ` · ${row.priceNote}` : ''}{row.conditions ? ` · ${row.conditions}` : ''}
                      {row.validYear ? ` · прайс ${row.validYear} года` : ''}
                    </p>
                    {!row.isActive && <span className="ds-badge mt-1">скрыта с сайта</span>}
                    {pending && (
                      <p className="text-xs text-[var(--warning)] mt-1">Черновик на модерации: {draftWords(pending)}.</p>
                    )}
                  </div>
                  <button
                    type="button"
                    className="ds-btn ds-btn-secondary text-sm flex items-center gap-1 shrink-0"
                    onClick={() => setEditing(editing === row.id ? null : row.id)}
                  >
                    <Pencil size={14} /> Изменить
                  </button>
                </div>
                {editing === row.id && (
                  <EditRowForm
                    row={row}
                    onDone={(msg) => { setEditing(null); say('ok', msg); onChanged(); }}
                    onError={(msg) => say('err', msg)}
                    onCancel={() => setEditing(null)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}

      {newPending.length > 0 && (
        <ul className="flex flex-col gap-2 mb-4" data-testid="new-price-drafts">
          {newPending.map((d) => (
            <li key={d.id} className="ds-card p-3 border-[var(--warning)]">
              <p className="text-sm font-semibold text-[var(--text-primary)]">
                Новая строка на модерации: {priceRowLabel({
                  lineKind: d.lineKind ?? 'destination', fromText: d.fromText, toText: d.toText, vehicleKind: d.vehicleKind ?? 'other',
                })}
              </p>
              <p className="text-xs text-[var(--text-secondary)]">{d.priceRub !== null ? `${formatRub(d.priceRub)} за машину` : ''}{d.priceNote ? ` · ${d.priceNote}` : ''}</p>
            </li>
          ))}
        </ul>
      )}

      {!adding ? (
        <button className="ds-btn ds-btn-secondary text-sm flex items-center gap-1.5" onClick={() => setAdding(true)}>
          <Plus size={14} /> Добавить строку прайса
        </button>
      ) : (
        <NewRowForm
          onDone={(msg) => { setAdding(false); say('ok', msg); onChanged(); }}
          onError={(msg) => say('err', msg)}
          onCancel={() => setAdding(false)}
        />
      )}

      <div className="mt-6" data-testid="price-drafts-history">
        <h3 className="ds-label mb-2">Решения по правкам за 30 дней</h3>
        {drafts.state === 'loading' && <p className="text-sm text-[var(--text-muted)]">Читаем…</p>}
        {drafts.state === 'failed' && (
          <p className="text-sm text-[var(--text-secondary)]">Не смогли прочитать черновики: {drafts.message}. Это не значит, что их нет.</p>
        )}
        {drafts.state === 'ok' && decided.length === 0 && <p className="text-sm text-[var(--text-secondary)]">Решений пока нет.</p>}
        {drafts.state === 'ok' && decided.length > 0 && (
          <ul className="flex flex-col gap-1">
            {decided.map((d) => (
              <li key={d.id} className="text-xs text-[var(--text-secondary)]">
                {d.moderatedAt ? whenRu(d.moderatedAt) : ''} · {STATUS_WORD[d.status]}
                {d.priceId ? `: ${draftWords(d)}` : `: новая строка${d.priceRub !== null ? ` ${formatRub(d.priceRub)}` : ''}`}
                {d.status === 'rejected' && <span className="text-[var(--danger)]"> — причина: {d.reason ?? 'не записана'}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function EditRowForm({ row, onDone, onError, onCancel }: {
  row: CharterPriceRow; onDone: (msg: string) => void; onError: (msg: string) => void; onCancel: () => void;
}) {
  const [price, setPrice] = useState('');
  const [note, setNote] = useState('');
  const [conditions, setConditions] = useState('');
  const [visibility, setVisibility] = useState<'keep' | 'show' | 'hide'>('keep');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const body: Record<string, unknown> = { priceId: row.id };
    if (price.trim()) body.priceRub = Number(price.trim());
    if (note.trim()) body.priceNote = note.trim();
    if (conditions.trim()) body.conditions = conditions.trim();
    if (visibility === 'show') body.isActive = true;
    if (visibility === 'hide') body.isActive = false;
    if (Object.keys(body).length === 1) { onError('Черновик ничего не меняет — заполните хотя бы одно поле'); return; }
    setBusy(true);
    try {
      const r = await postJson(body);
      if (!r.ok) { onError(r.error ?? 'Черновик не записан'); return; }
      onDone(r.message ?? 'Черновик записан');
    } finally { setBusy(false); }
  };

  return (
    <form className="grid grid-cols-2 gap-3 mt-3 pt-3 border-t border-[var(--border)]" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <label className="text-xs text-[var(--text-secondary)]">Новая цена, ₽ за машину (пусто — не менять)
        <input type="number" min={1} step={1} className="ds-input mt-1 w-full" value={price} onChange={(e) => setPrice(e.target.value)} placeholder={String(row.priceRub)} />
      </label>
      <label className="text-xs text-[var(--text-secondary)]">На сайте
        <select className="ds-input mt-1 w-full" value={visibility} onChange={(e) => setVisibility(e.target.value as 'keep' | 'show' | 'hide')}>
          <option value="keep">как сейчас ({row.isActive ? 'показана' : 'скрыта'})</option>
          <option value="show">показать</option>
          <option value="hide">скрыть</option>
        </select>
      </label>
      <label className="text-xs text-[var(--text-secondary)] col-span-2">Примечание (пусто — не менять)
        <input className="ds-input mt-1 w-full" value={note} onChange={(e) => setNote(e.target.value)} maxLength={255} placeholder={row.priceNote ?? 'например: плюс переправы'} />
      </label>
      <label className="text-xs text-[var(--text-secondary)] col-span-2">Условия (пусто — не менять)
        <input className="ds-input mt-1 w-full" value={conditions} onChange={(e) => setConditions(e.target.value)} maxLength={2000} placeholder={row.conditions ?? 'например: при расчёте наличными'} />
      </label>
      <div className="col-span-2 flex gap-2">
        <button type="submit" className="ds-btn ds-btn-primary text-sm" disabled={busy}>{busy ? 'Отправляем…' : 'Отправить на модерацию'}</button>
        <button type="button" className="ds-btn ds-btn-secondary text-sm" onClick={onCancel}>Отмена</button>
      </div>
    </form>
  );
}

function NewRowForm({ onDone, onError, onCancel }: { onDone: (msg: string) => void; onError: (msg: string) => void; onCancel: () => void }) {
  const [vehicleKind, setVehicleKind] = useState<CharterVehicleKind>('vahtovka');
  const [lineKind, setLineKind] = useState<CharterLineKind>('destination');
  const [from, setFrom] = useState('Петропавловск-Камчатский');
  const [to, setTo] = useState('');
  const [price, setPrice] = useState('');
  const [note, setNote] = useState('');
  const [conditions, setConditions] = useState('');
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [busy, setBusy] = useState(false);
  const isDestination = lineKind === 'destination';

  const submit = async () => {
    setBusy(true);
    try {
      const r = await postJson({
        vehicleKind,
        lineKind,
        fromText: isDestination ? from.trim() || null : null,
        toText: isDestination ? to.trim() || null : null,
        priceRub: Number(price.trim()),
        priceNote: note.trim() || null,
        conditions: conditions.trim() || null,
        validYear: year.trim() ? Number(year.trim()) : null,
      });
      if (!r.ok) { onError(r.error ?? 'Черновик не записан'); return; }
      onDone(r.message ?? 'Черновик новой строки записан');
    } finally { setBusy(false); }
  };

  return (
    <form className="ds-card p-4 grid grid-cols-2 gap-3" data-testid="new-price-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <label className="text-xs text-[var(--text-secondary)]">Вид машины
        <select className="ds-input mt-1 w-full" value={vehicleKind} onChange={(e) => setVehicleKind(e.target.value as CharterVehicleKind)}>
          {CHARTER_VEHICLE_KINDS.map((k) => <option key={k} value={k}>{VEHICLE_KIND_LABEL[k]}</option>)}
        </select>
      </label>
      <label className="text-xs text-[var(--text-secondary)]">За что цена
        <select className="ds-input mt-1 w-full" value={lineKind} onChange={(e) => setLineKind(e.target.value as CharterLineKind)}>
          {CHARTER_LINE_KINDS.map((k) => <option key={k} value={k}>{LINE_KIND_LABEL[k]}</option>)}
        </select>
      </label>
      {isDestination && (
        <>
          <label className="text-xs text-[var(--text-secondary)]">Откуда
            <input className="ds-input mt-1 w-full" value={from} onChange={(e) => setFrom(e.target.value)} required maxLength={255} />
          </label>
          <label className="text-xs text-[var(--text-secondary)]">Куда
            <input className="ds-input mt-1 w-full" value={to} onChange={(e) => setTo(e.target.value)} required maxLength={255} placeholder="Авачинский перевал" />
          </label>
        </>
      )}
      <label className="text-xs text-[var(--text-secondary)]">Цена, ₽ за машину
        <input type="number" min={1} step={1} className="ds-input mt-1 w-full" value={price} onChange={(e) => setPrice(e.target.value)} required />
      </label>
      <label className="text-xs text-[var(--text-secondary)]">Год прайса (пусто — не записан)
        <input type="number" min={2020} max={2100} className="ds-input mt-1 w-full" value={year} onChange={(e) => setYear(e.target.value)} />
      </label>
      <label className="text-xs text-[var(--text-secondary)] col-span-2">Примечание
        <input className="ds-input mt-1 w-full" value={note} onChange={(e) => setNote(e.target.value)} maxLength={255} placeholder="плюс переправы" />
      </label>
      <label className="text-xs text-[var(--text-secondary)] col-span-2">Условия
        <input className="ds-input mt-1 w-full" value={conditions} onChange={(e) => setConditions(e.target.value)} maxLength={2000} placeholder="при расчёте наличными" />
      </label>
      <div className="col-span-2 flex gap-2">
        <button type="submit" className="ds-btn ds-btn-primary text-sm" disabled={busy}>{busy ? 'Отправляем…' : 'Отправить на модерацию'}</button>
        <button type="button" className="ds-btn ds-btn-secondary text-sm" onClick={onCancel}>Отмена</button>
      </div>
    </form>
  );
}
