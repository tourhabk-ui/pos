'use client';

/**
 * Плашка «обстановка в крае» поверх полевой карты (#1428) и панель «Угрозы по
 * районам» под ней (#2930).
 *
 * Логика исходов — `lib/safety/map-threat-summary` и
 * `lib/safety/map-zone-threats` (чистые, со сторожами). Здесь только доставка:
 * сеть → кеш телефона → «неизвестно». Последний ответ хранится в localStorage,
 * чтобы без сети плашка и панель говорили, что было известно и когда, а не
 * пропадали и не рисовали спокойствие.
 *
 * Нажатие на плашку раскрывает панель по районам. Ссылка на радар угроз
 * (/safety#radar) — внутри панели: до 10.11 плашка вела туда сразу, и узнать,
 * какой район касается тревога, с карты было нельзя.
 *
 * Стекло поверх карты — по §2 CLAUDE.md: тёмное, тревога узнаётся кромкой
 * цвета предупреждения, а не заливкой. Цвета текста — --glass-fg /
 * --glass-fg-muted, а не data-theme="dark": /map проверяет token-gate, и
 * переопределение --accent/--danger на элементе для него — нарушение.
 *
 * Стекло плотное (fx-glass-dense): на плашке текст, а под ней светлая карта
 * или её подложка. На тонком стекле (чёрный 40%) строка «Действующих тревог
 * нет» давала 3,5:1 — Lighthouse, прогон 14 (14.10), color-contrast на /map.
 */

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronUp, ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react';
import { ageLabel, mapThreatSummary, type MapThreatSummary, type SafetyStatusPayload } from '@/lib/safety/map-threat-summary';
import { districtStateLine, mapZoneThreats, type DangerSummaryPayload, type ZoneThreats } from '@/lib/safety/map-zone-threats';

const CACHE_KEY = 'vedar_map_threat';
const RISK_CACHE_KEY = 'vedar_map_zone_risk';

function readCache<T>(key: string): { data: T; ts: number } | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { data?: T; ts?: number };
    return parsed.data && typeof parsed.ts === 'number' ? { data: parsed.data, ts: parsed.ts } : null;
  } catch {
    return null;
  }
}

function writeCache(key: string, data: unknown): void {
  try { localStorage.setItem(key, JSON.stringify({ data, ts: Date.now() })); } catch { /* приватный режим */ }
}

/** Ответ для панели и его возраст (null — свежий из сети); pending — ещё идёт запрос. */
interface Known<T> { data: T | null; ageMs: number | null; pending?: boolean }

export function MapThreatChip() {
  const [summary, setSummary] = useState<MapThreatSummary | null>(null);
  const [feed, setFeed] = useState<Known<SafetyStatusPayload>>({ data: null, ageMs: null });
  const [risk, setRisk] = useState<Known<DangerSummaryPayload> | null>(null);
  const [open, setOpen] = useState(false);
  const panelId = useId();

  useEffect(() => {
    let cancelled = false;
    const cached = readCache<SafetyStatusPayload>(CACHE_KEY);
    if (cached) {
      setSummary(mapThreatSummary(cached.data, Date.now() - cached.ts));
      setFeed({ data: cached.data, ageMs: Date.now() - cached.ts });
    }

    fetch('/api/public/safety-status')
      .then(r => r.json())
      .then((j: { success?: boolean; data?: SafetyStatusPayload }) => {
        if (cancelled) return;
        if (j?.success && j.data) {
          // Недоступный источник не затирает прежний известный ответ.
          if (j.data.unavailable !== true) writeCache(CACHE_KEY, j.data);
          if (j.data.unavailable === true && cached) {
            setSummary(mapThreatSummary(cached.data, Date.now() - cached.ts));
          } else {
            setSummary(mapThreatSummary(j.data));
            setFeed({ data: j.data, ageMs: null });
          }
        } else if (!cached) {
          setSummary(mapThreatSummary(null));
        }
      })
      .catch(() => {
        // Без сети: кеш уже показан; кеша нет — честное «неизвестно».
        if (!cancelled && !cached) setSummary(mapThreatSummary(null));
      });
    return () => { cancelled = true; };
  }, []);

  // Оценка зон — один раз, при первом раскрытии панели: плашке она не нужна.
  // Запрос не отменяется сменой состояния (setRisk ниже перерисует плашку),
  // только уходом со страницы.
  const riskAsked = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!open || riskAsked.current) return;
    riskAsked.current = true;
    const cached = readCache<DangerSummaryPayload>(RISK_CACHE_KEY);
    setRisk(cached ? { data: cached.data, ageMs: Date.now() - cached.ts } : { data: null, ageMs: null, pending: true });
    fetch('/api/public/danger-summary')
      .then(r => r.json())
      .then((j: DangerSummaryPayload) => {
        if (!mounted.current) return;
        if (j && j.ok !== false) {
          writeCache(RISK_CACHE_KEY, j);
          setRisk({ data: j, ageMs: null });
        } else if (!cached) {
          setRisk({ data: { ok: false }, ageMs: null });
        }
      })
      .catch(() => {
        // Без сети: кеш уже показан с возрастом; кеша нет — «не прочиталась».
        if (mounted.current && !cached) setRisk({ data: { ok: false }, ageMs: null });
      });
  }, [open]);

  if (!summary) return null;

  const Icon = summary.state === 'alert' ? ShieldAlert : summary.state === 'calm' ? ShieldCheck : ShieldQuestion;
  const edge = summary.state === 'alert' ? 'var(--warning)' : 'rgba(255,255,255,0.15)';
  const Chevron = open ? ChevronUp : ChevronDown;

  return (
    <div className="flex flex-col gap-2 max-w-[300px]">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`${summary.label}${summary.detail ? `. ${summary.detail}` : ''}. ${open ? 'Свернуть' : 'Показать'} угрозы по районам`}
        onClick={() => setOpen((v) => !v)}
        className="fx-glass-dense flex items-start gap-2 max-w-[260px] px-3 py-2 rounded-2xl text-left transition-all duration-200"
        style={{ borderColor: edge, color: 'var(--glass-fg)' }}
      >
        <Icon className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: summary.state === 'alert' ? 'var(--warning)' : 'var(--glass-fg-muted)' }} aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-bold leading-tight">{summary.label}</span>
          {summary.detail && (
            <span className="block text-[11px] leading-snug mt-0.5 line-clamp-2" style={{ color: 'var(--glass-fg-muted)' }}>
              {summary.detail}
            </span>
          )}
        </span>
        <Chevron className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: 'var(--glass-fg-muted)' }} aria-hidden="true" />
      </button>
      {open && (
        <ZoneThreatsPanel
          id={panelId}
          threats={mapZoneThreats(feed.data, risk?.data ?? null)}
          feedAgeMs={feed.ageMs}
          riskAgeMs={risk?.ageMs ?? null}
          riskPending={risk?.pending === true}
        />
      )}
    </div>
  );
}

function ZoneThreatsPanel({ id, threats, feedAgeMs, riskAgeMs, riskPending }: {
  id: string; threats: ZoneThreats; feedAgeMs: number | null; riskAgeMs: number | null; riskPending: boolean;
}) {
  const muted = { color: 'var(--glass-fg-muted)' };
  return (
    <section
      id={id}
      aria-label="Угрозы по районам"
      className="fx-glass-dense rounded-2xl px-3 py-2.5 max-h-[50vh] overflow-y-auto"
      style={{ color: 'var(--glass-fg)' }}
    >
      <h2 className="text-xs font-bold leading-tight">Угрозы по районам</h2>
      <p className="text-[11px] leading-snug mt-0.5" style={muted}>
        Район — как в сводке. Границ районов в данных нет, поэтому списком, без контуров на карте.
        {feedAgeMs != null && ` Лента — ${ageLabel(feedAgeMs)}, сейчас могла измениться.`}
      </p>

      {!threats.feedKnown && (
        <p className="text-[11px] leading-snug mt-2">
          Лента тревог не прочиталась — что в районах, неизвестно. Это не «спокойно».
        </p>
      )}

      {threats.kraiWide.length > 0 && (
        <div className="mt-2">
          <h3 className="text-[11px] font-bold leading-tight" style={{ color: 'var(--warning)' }}>По всему краю</h3>
          <ul className="mt-0.5 space-y-0.5">
            {threats.kraiWide.map((t) => <li key={t} className="text-[11px] leading-snug">{t}</li>)}
          </ul>
        </div>
      )}

      <ul className="mt-2 space-y-2">
        {threats.districts.map((d) => (
          <li key={d.zone} className="pl-2" style={{ borderLeft: `2px solid ${d.state === 'alert' ? 'var(--warning)' : 'rgba(255,255,255,0.15)'}` }}>
            <div className="text-[11px] font-bold leading-tight">{d.name}</div>
            <div className="text-[11px] leading-snug" style={d.state === 'alert' ? undefined : muted}>{districtStateLine(d)}</div>
            {d.alerts.length > 0 && (
              <ul className="mt-0.5 space-y-0.5">
                {d.alerts.map((t) => <li key={t} className="text-[11px] leading-snug">{t}</li>)}
              </ul>
            )}
            {d.risk && (
              <div className="text-[11px] leading-snug" style={muted}>Расчётная оценка: {d.risk.toLowerCase()}</div>
            )}
          </li>
        ))}
      </ul>

      {threats.unzoned.length > 0 && (
        <div className="mt-2">
          <h3 className="text-[11px] font-bold leading-tight">Район в сводке не указан</h3>
          <ul className="mt-0.5 space-y-0.5">
            {threats.unzoned.map((t) => <li key={t} className="text-[11px] leading-snug">{t}</li>)}
          </ul>
        </div>
      )}

      {threats.more > 0 && (
        <p className="text-[11px] leading-snug mt-2" style={muted}>…и ещё {threats.more} в ленте на радаре угроз.</p>
      )}
      {threats.feedKnown && !threats.riskKnown && (
        <p className="text-[11px] leading-snug mt-2" style={muted}>
          {riskPending ? 'Расчётная оценка районов загружается…' : 'Расчётная оценка районов не прочиталась.'}
        </p>
      )}
      {threats.riskKnown && riskAgeMs != null && (
        <p className="text-[11px] leading-snug mt-2" style={muted}>Оценка районов — {ageLabel(riskAgeMs)}.</p>
      )}

      <Link href="/safety#radar" className="inline-block mt-2 text-[11px] font-bold underline underline-offset-2">
        Радар угроз — подробности и источники
      </Link>
      <p className="text-[11px] leading-snug mt-1" style={muted}>Экстренный вызов — 112.</p>
    </section>
  );
}
