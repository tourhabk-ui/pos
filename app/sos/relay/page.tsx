'use client';

/**
 * /sos/relay — приём QR-эстафеты SOS (см. lib/mesh/qr-relay.ts).
 *
 * Открывается на телефоне ПОПУТЧИКА после скана QR пострадавшего. Оба могли
 * быть офлайн в момент скана: страница в precache service worker'а, payload
 * целиком в hash-фрагменте — сеть не нужна, чтобы ПРИНЯТЬ сигнал на хранение.
 *
 * Дальше два исхода, оба честные:
 * - связь есть → доставка сразу через /api/mesh/sos-relay (дедуп по sos_id —
 *   один QR могли отсканировать несколько человек);
 * - связи нет → SOS ложится в офлайн-очередь ЭТОГО телефона и уходит сам,
 *   когда попутчик спустится в зону покрытия (Background Sync + флаш).
 *
 * Критичный экран действия — без стекла, непрозрачный (§2 CLAUDE.md).
 */

import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle, Clock, MapPin, Phone } from 'lucide-react';
import { parseRelayHash, type QrSosPayload } from '@/lib/mesh/qr-relay';
import { queueSOS, registerSOSSync, installSOSFlush } from '@/lib/offline/pending-queue';

type RelayState =
  | { phase: 'reading' }
  | { phase: 'empty' }
  | { phase: 'delivering'; sos: QrSosPayload }
  | { phase: 'delivered'; sos: QrSosPayload }
  | { phase: 'stored'; sos: QrSosPayload }
  | { phase: 'failed'; sos: QrSosPayload };

function relayerId(): string {
  try {
    const key = 'mesh-device-id';
    const existing = localStorage.getItem(key);
    if (existing) return `qr:${existing.slice(0, 32)}`;
    const fresh = crypto.randomUUID();
    localStorage.setItem(key, fresh);
    return `qr:${fresh.slice(0, 32)}`;
  } catch {
    return `qr:${Math.random().toString(36).slice(2, 12)}`;
  }
}

async function deliverNow(sos: QrSosPayload): Promise<boolean> {
  try {
    const res = await fetch('/api/mesh/sos-relay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sos_id: sos.sos_id,
        relayed_by: relayerId(),
        sos: {
          lat: sos.lat,
          lng: sos.lng,
          accuracy: sos.accuracy,
          message: sos.message,
          tourist_name: sos.tourist_name,
          tourist_phone: sos.tourist_phone,
        },
      }),
    });
    // 429 лимитера ретрансляций — сигнал НЕ доставлен, храним в очереди
    return res.ok;
  } catch {
    return false;
  }
}

async function storeForLater(sos: QrSosPayload): Promise<boolean> {
  try {
    await queueSOS({
      lat: sos.lat,
      lng: sos.lng,
      accuracy: sos.accuracy,
      tourist_name: sos.tourist_name,
      tourist_phone: sos.tourist_phone,
      message: sos.message,
      relay: { sos_id: sos.sos_id, relayed_by: relayerId() },
    });
    await registerSOSSync();
    installSOSFlush();
    return true;
  } catch {
    return false;
  }
}

function agoLabel(shownAt: number): string {
  const mins = Math.max(0, Math.round((Date.now() - shownAt) / 60000));
  if (mins < 1) return 'только что';
  if (mins < 60) return `${mins} мин назад`;
  const h = Math.floor(mins / 60);
  return `${h} ч ${mins % 60} мин назад`;
}

export default function SosRelayPage() {
  const [state, setState] = useState<RelayState>({ phase: 'reading' });

  useEffect(() => {
    const sos = parseRelayHash(window.location.hash);
    if (!sos) {
      setState({ phase: 'empty' });
      return;
    }
    setState({ phase: 'delivering', sos });

    void (async () => {
      if (navigator.onLine && await deliverNow(sos)) {
        setState({ phase: 'delivered', sos });
        return;
      }
      // Нет сети или сервер не подтвердил — кладём на хранение. Дубль при
      // будущем флаше дешевле потерянного сигнала: сервер дедуплицирует.
      if (await storeForLater(sos)) {
        setState({ phase: 'stored', sos });
      } else {
        setState({ phase: 'failed', sos });
      }
    })();
  }, []);

  const sos = 'sos' in state ? state.sos : null;
  const coordsText = sos && sos.lat != null && sos.lng != null
    ? `${sos.lat.toFixed(5)}°N, ${sos.lng.toFixed(5)}°E`
    : null;

  return (
    <main className="min-h-screen bg-[var(--bg-primary)] px-4 py-8">
      <div className="max-w-md mx-auto space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-full bg-[var(--danger)] flex items-center justify-center shrink-0">
            <AlertTriangle className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-[var(--text-primary)]">SOS туриста рядом</h1>
            <p className="text-sm text-[var(--text-secondary)]">Вы отсканировали сигнал бедствия</p>
          </div>
        </div>

        {state.phase === 'empty' && (
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-5">
            <p className="text-sm text-[var(--text-primary)]">
              В ссылке нет данных сигнала. Попросите пострадавшего показать QR-код
              с экрана «Экстренная помощь» ещё раз и отсканируйте заново.
            </p>
          </div>
        )}

        {sos && (
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-5 space-y-3">
            {coordsText ? (
              <div className="flex items-start gap-2.5">
                <MapPin className="w-5 h-5 text-[var(--danger)] shrink-0 mt-0.5" />
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-[var(--text-muted)]">Координаты пострадавшего</div>
                  <div className="text-lg font-mono font-bold text-[var(--text-primary)]">{coordsText}</div>
                  {sos.accuracy != null && (
                    <div className="text-xs text-[var(--text-muted)]">точность ±{Math.round(sos.accuracy)} м</div>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-sm text-[var(--warning)]">В сигнале нет координат — запомните, где вы встретили этого человека.</p>
            )}

            {sos.tourist_name && (
              <div className="text-sm text-[var(--text-primary)]">Имя: <b>{sos.tourist_name}</b></div>
            )}
            {sos.tourist_phone && (
              <div className="text-sm text-[var(--text-primary)]">Телефон: <b>{sos.tourist_phone}</b></div>
            )}
            {sos.message && (
              <div className="text-sm text-[var(--text-secondary)]">«{sos.message}»</div>
            )}
            <div className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
              <Clock className="w-3.5 h-3.5" />
              QR показан {agoLabel(sos.shown_at)}
            </div>
          </div>
        )}

        {state.phase === 'delivering' && (
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4 text-sm text-[var(--text-secondary)]">
            Передаём сигнал…
          </div>
        )}

        {state.phase === 'delivered' && (
          <div className="bg-[var(--bg-card)] border border-[var(--success)] rounded-lg p-4 flex items-start gap-2.5">
            <CheckCircle className="w-5 h-5 text-[var(--success)] shrink-0 mt-0.5" />
            <p className="text-sm text-[var(--text-primary)]">
              <b>Сигнал передан спасателям платформы.</b> Если можете — всё равно
              позвоните 112 и назовите координаты с этого экрана.
            </p>
          </div>
        )}

        {state.phase === 'stored' && (
          <div className="bg-[var(--bg-card)] border border-[var(--warning)] rounded-lg p-4 space-y-2">
            <p className="text-sm text-[var(--text-primary)]">
              <b>Сети нет — сигнал сохранён на вашем телефоне.</b> Он отправится сам,
              как только появится связь. Не закрывайте вкладку насовсем и не чистите браузер.
            </p>
            <p className="text-xs text-[var(--text-secondary)]">
              Как только окажетесь в зоне покрытия — откройте эту страницу ещё раз,
              это ускорит доставку.
            </p>
          </div>
        )}

        {state.phase === 'failed' && (
          <div className="bg-[var(--bg-card)] border border-[var(--danger)] rounded-lg p-4">
            <p className="text-sm text-[var(--text-primary)]">
              <b>Не удалось ни передать, ни сохранить сигнал.</b> Запишите координаты
              с этого экрана (фото/бумага) и позвоните 112, как только появится связь.
            </p>
          </div>
        )}

        <a
          href={`tel:112`}
          className="flex items-center justify-center gap-2 w-full py-3 bg-[var(--danger)] text-white text-sm font-bold rounded-lg"
        >
          <Phone className="w-4 h-4" />
          Позвонить 112 {coordsText ? '— назвать координаты' : ''}
        </a>

        <p className="text-xs text-[var(--text-muted)] leading-relaxed">
          Звонок 112 работает даже без SIM-карты и при нулевом балансе, в любой
          доступной сети. Голос и SMS часто пробиваются там, где интернета уже нет.
        </p>
      </div>
    </main>
  );
}
