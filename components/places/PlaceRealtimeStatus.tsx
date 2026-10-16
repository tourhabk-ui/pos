'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle, XCircle, AlertOctagon, HelpCircle, Users } from 'lucide-react';
import type { PlaceRealtime } from './types';
import { crowdsOnScale } from '@/lib/safety/profile-source';
import { kamchatkaStamp, placeDayStatus, type PlaceDayLevel } from '@/lib/safety/place-day-status';
import { KURIL_NORTH_NOTE } from '@/lib/safety/kuril-north';

interface Props {
  realtime: PlaceRealtime;
  /** Место — вулкан: его шкалы (KVERT, КФ ЕГС) поднимают уровень места. */
  isVolcano?: boolean;
  /** Код KVERT самого места, если он известен (блок вулкана ниже). */
  volcanoColor?: string | null;
  /** Для проверок: «сейчас» в миллисекундах. */
  now?: number;
}

/**
 * Строка статуса отвечает на вопрос человека «что там сегодня?» — словами
 * того, что платформа ЗНАЕТ (19.09 — ответ, а не ярлык; 15.10 — §0
 * «честность»).
 *
 * До 15.10 зелёный ответ был «Сегодня можно идти» и «Запретов и
 * предупреждений нет». Это обещание, которого никто не давал: уровень
 * считался по значению по умолчанию и по своей шкале, где действующее
 * предупреждение уровня 1 печаталось под «предупреждений нет», а критичное
 * (2) — «идти можно, но осторожно». Уровень теперь — пересчёт сводок, тот же,
 * что у Кузьмича в чате (`placeDayStatus`), а зелёный говорит ровно то, что
 * посчитано: предупреждений в сводках нет, и это не проверка самого места.
 *
 * Причина идёт отдельной строкой, а не склеивается с ответом: «Сегодня там
 * опасно» / «Паводок на реке Камчатка» — ответ и причина двумя голосами.
 */
const LEVEL_CONFIG: Record<PlaceDayLevel, {
  bg: string; text: string; Icon: typeof CheckCircle; answer: string;
}> = {
  closed: {
    bg: 'bg-[var(--danger)]/10 border-[var(--danger)]/30',
    text: 'text-[var(--danger)]',
    Icon: XCircle,
    answer: 'Закрыто для посещения',
  },
  red: {
    bg: 'bg-[var(--danger)]/10 border-[var(--danger)]/30',
    text: 'text-[var(--danger)]',
    Icon: AlertOctagon,
    answer: 'Сегодня там опасно',
  },
  yellow: {
    bg: 'bg-[var(--warning)]/10 border-[var(--warning)]/30',
    text: 'text-[var(--warning)]',
    Icon: AlertTriangle,
    answer: 'Есть предупреждение — прочитайте, прежде чем ехать',
  },
  green: {
    bg: 'bg-[var(--success)]/10 border-[var(--success)]/30',
    text: 'text-[var(--success)]',
    Icon: CheckCircle,
    answer: 'Предупреждений по месту нет',
  },
  // Не знаем — не тревога и не «спокойно»: нейтральный тон, без зелёного.
  unknown: {
    bg: 'bg-[var(--bg-card)] border-[var(--border)]',
    text: 'text-[var(--text-secondary)]',
    Icon: HelpCircle,
    answer: 'Обстановку сейчас не знаем',
  },
};

const KVERT_WORD: Record<string, string> = { yellow: 'жёлтый', orange: 'оранжевый', red: 'красный' };

/** Предупреждения из сводок — уже по убыванию опасности (safety-ingest), без пустых и повторов. */
function alertsOf(rt: PlaceRealtime): string[] {
  return [...new Set((rt.activeAlerts ?? []).map((a) => a.trim()).filter(Boolean))];
}

/**
 * Почему уровень поднят, если ни одного заголовка тревоги у места нет.
 *
 * Без заголовков пересчёт поднимает уровень только шкалами вулкана — своего
 * или привязанного поимённо (1029): правило заполненности по числу туристов
 * молчит, `tourists_today` не пишет никто (1100).
 */
function raisedWithoutAlerts(rt: PlaceRealtime, isVolcano: boolean, volcanoColor: string | null | undefined): string {
  if (volcanoColor && KVERT_WORD[volcanoColor]) {
    return `Код вулкана KVERT — ${KVERT_WORD[volcanoColor]}. Подробности — в блоке вулкана ниже.`;
  }
  if (rt.linkedVolcanoes) {
    return `Место у вулкана ${rt.linkedVolcanoes}: уровень поднят его шкалами KVERT и КФ ЕГС.`;
  }
  if (isVolcano) return 'Уровень поднят шкалами вулкана — кодом KVERT или сводкой КФ ЕГС.';
  // Пересчёт поднял уровень и не оставил заголовка — так и говорим (§4.0).
  return 'Причину пересчёт не записал — уточните обстановку у МЧС.';
}

export default function PlaceRealtimeStatus({ realtime, isVolcano = false, volcanoColor, now }: Props) {
  const { level, stale, outsideSources } = placeDayStatus(realtime, now);
  const cfg = LEVEL_CONFIG[level];
  const { Icon } = cfg;
  const isSticky = level === 'red' || level === 'closed';
  const [stuck, setStuck] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isSticky) return;
    const handler = () => {
      const scrollY = window.scrollY;
      const vh200 = window.innerHeight * 2;
      setStuck(scrollY > 0 && scrollY < vh200);
    };
    window.addEventListener('scroll', handler, { passive: true });
    return () => window.removeEventListener('scroll', handler);
  }, [isSticky]);

  const alerts = alertsOf(realtime);
  const note = realtime.alertMessage?.trim() || null;

  // Зелёный при действующих предупреждениях слабее уровня места — не
  // «предупреждений нет»: они есть, просто не поднимают уровень.
  const answer = level === 'green' && alerts.length > 0 ? 'Серьёзных предупреждений нет' : cfg.answer;

  // Строки под ответом. Своего текста вместо причины не выдумываем.
  const lines: string[] = [];
  if (level === 'closed') {
    lines.push(note ?? 'Причина не записана — уточните у МЧС.');
  } else if (level === 'unknown') {
    lines.push(outsideSources
      ? KURIL_NORTH_NOTE
      : stale
        ? 'Пересчёт по сводкам давно не обновлялся — цвет не показываем: он может быть уже не про сегодня.'
        : 'Пересчёта обстановки по этому месту у нас нет.');
    if (note) lines.push(note);
    // Тихо уронить, возможно, ещё действующее предупреждение опаснее, чем
    // показать его с рамкой давности.
    if (alerts.length > 0) lines.push(`В последнем пересчёте: ${alerts.slice(0, 3).join('; ')}`);
    // У Северных Курил совет — в самой записке, с адресом: второй раз не нужен.
    if (!outsideSources) lines.push('Перед выходом уточните обстановку сами.');
  } else {
    if (note) lines.push(note);
    if (alerts.length > 0) {
      lines.push(...alerts.slice(0, 3));
      if (alerts.length > 3) lines.push(`и ещё ${alerts.length - 3}`);
    } else if (level !== 'green' && !note) {
      lines.push(raisedWithoutAlerts(realtime, isVolcano, volcanoColor));
    }
    if (level === 'green') {
      lines.push('Это пересчёт по лентам предупреждений, а не проверка самого места: погоду и тропу проверьте перед выходом.');
    }
  }

  // Шкала одна и читается одним правилом: ноль и всё вне 1-5 — «не измеряли»,
  // а не «свободно» (lib/safety/profile-source.ts).
  const crowds = crowdsOnScale(realtime.currentCrowds);
  const crowdsLabel =
    crowds == null ? null :
    crowds <= 2    ? 'Свободно' :
    crowds === 3   ? 'Умеренно' :
    crowds === 4   ? 'Многолюдно' : 'Переполнено';
  const crowdsColor =
    crowds == null ? '' :
    crowds <= 2    ? 'text-[var(--success)]' :
    crowds === 3   ? 'text-[var(--warning)]' : 'text-[var(--danger)]';

  /**
   * Свежесть видна ВСЕГДА и на телефоне тоже: статус без времени читается как
   * «сейчас». И называется она тем, что произошло, — пересчётом сводок, а не
   * «проверили»: место никто не проверял, крон перечитал ленты. Время — по
   * Камчатке, одинаково на сервере и в браузере.
   */
  const updatedStr = realtime.updatedAt
    ? `Сводки пересчитаны ${kamchatkaStamp(realtime.updatedAt)} по Камчатке`
    : 'Когда пересчитывали — у нас не записано';

  return (
    <div
      ref={ref}
      role="status"
      className={`w-full border-b border-t transition-all ${cfg.bg} ${isSticky && stuck ? 'sticky top-0 z-40 shadow-md' : ''}`}
    >
      <div className="max-w-3xl mx-auto px-4 py-3 flex items-start gap-3">
        <Icon className={`w-5 h-5 flex-shrink-0 mt-0.5 ${cfg.text}`} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className={`text-[15px] font-semibold leading-snug ${cfg.text}`}>{answer}</p>
          {lines.map((l, i) => (
            <p key={i} className="mt-1 text-sm leading-snug text-[var(--text-secondary)]">{l}</p>
          ))}
          <p className="mt-1 text-xs text-[var(--text-muted)]">{updatedStr}</p>
        </div>
        {crowdsLabel && (
          <span className={`flex flex-shrink-0 items-center gap-1 text-xs font-medium ${crowdsColor}`}>
            <Users className="w-3.5 h-3.5" />
            {crowdsLabel}
          </span>
        )}
      </div>
    </div>
  );
}
