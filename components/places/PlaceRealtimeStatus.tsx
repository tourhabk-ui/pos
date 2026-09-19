'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle, XCircle, AlertOctagon, Users } from 'lucide-react';
import type { PlaceRealtime } from './types';

interface Props {
  realtime: PlaceRealtime;
}

type Level = 'green' | 'yellow' | 'orange' | 'red';

function getLevel(rt: PlaceRealtime): Level {
  if (!rt.isOpen) return 'red';
  const sev = rt.alertSeverity ?? 0;
  if (sev >= 4) return 'red';
  if (sev === 3) return 'orange';
  if (sev === 2) return 'yellow';
  return 'green';
}

/**
 * Строка статуса отвечает на ВОПРОС, а не называет состояние (19.09,
 * направление D — «нужно всё-таки UX и более дружественный интерфейс»).
 *
 * Человек, открывший карточку, спрашивает одно: «мне туда сегодня можно?»
 * Прежние подписи отвечали не ему: «Открыто, без предупреждений» — это выписка
 * из реестра, «Внимание» и «Ограничения» — ярлыки уровня, по которым ещё надо
 * догадаться, что делать. Уровень (`getLevel`) не тронут: он решает цвет и
 * липкость, то есть безопасность, и переписаны только слова.
 *
 * Причина от источника (`alertMessage`) больше не склеивается с ярлыком через
 * двоеточие, а идёт ВТОРОЙ строкой: «Сегодня туда нельзя» / «Перевал закрыт
 * из-за лавинной опасности» — ответ и причина, а не одно предложение из двух
 * разных голосов.
 */
const LEVEL_CONFIG = {
  green: {
    bg: 'bg-[var(--success)]/10 border-[var(--success)]/30',
    text: 'text-[var(--success)]',
    Icon: CheckCircle,
    answer: 'Сегодня можно идти',
    calm: 'Запретов и предупреждений нет',
  },
  yellow: {
    bg: 'bg-[var(--warning)]/10 border-[var(--warning)]/30',
    text: 'text-[var(--warning)]',
    Icon: AlertTriangle,
    answer: 'Идти можно, но осторожно',
    calm: 'Есть предупреждение — прочитайте ниже',
  },
  orange: {
    bg: 'bg-orange-500/10 border-orange-500/30',
    text: 'text-orange-500',
    Icon: AlertOctagon,
    answer: 'Сегодня есть ограничения',
    calm: 'Прочитайте, что именно, прежде чем ехать',
  },
  red: {
    bg: 'bg-[var(--danger)]/10 border-[var(--danger)]/30',
    text: 'text-[var(--danger)]',
    Icon: XCircle,
    answer: 'Сегодня туда нельзя',
    calm: 'Причина не указана — уточните у МЧС',
  },
};

export default function PlaceRealtimeStatus({ realtime }: Props) {
  const level = getLevel(realtime);
  const cfg = LEVEL_CONFIG[level];
  const { Icon } = cfg;
  const isSticky = level === 'red' || level === 'orange';
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

  // Ответ — по уровню; открытое место с сильной тревогой закрытым не называем.
  const answer = level === 'red' && realtime.isOpen ? 'Сегодня там опасно' : cfg.answer;
  // Вторая строка — причина от источника, если она есть. Своего текста вместо
  // неё не выдумываем: `calm` говорит ровно то, что мы знаем, — «причины нам не
  // сообщили» (§4.0), а не «всё в порядке».
  const reason = realtime.alertMessage?.trim() || cfg.calm;

  const crowds = realtime.currentCrowds;
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
   * Свежесть видна ВСЕГДА и на телефоне тоже.
   *
   * Прежняя строка стояла под `hidden sm:block` — то есть ровно на том
   * устройстве, с которым человек стоит в поле, время проверки не показывалось
   * вовсе. Статус без времени читается как «сейчас», хотя запись может быть
   * трёхдневной: это обещание свежести, которого никто не давал.
   *
   * Нет времени в записи — так и сказано словами. «Не знаем, когда проверяли» и
   * «проверяли только что» — разные состояния (§4.0), и молчание выдавало
   * первое за второе.
   */
  const updatedStr = realtime.updatedAt
    ? `Проверили ${new Date(realtime.updatedAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
    : 'Когда проверяли — у нас не записано';

  return (
    <div
      ref={ref}
      className={`w-full border-b border-t transition-all ${cfg.bg} ${isSticky && stuck ? 'sticky top-0 z-40 shadow-md' : ''}`}
    >
      <div className="max-w-3xl mx-auto px-4 py-3 flex items-start gap-3">
        <Icon className={`w-5 h-5 flex-shrink-0 mt-0.5 ${cfg.text}`} />
        <div className="min-w-0 flex-1">
          <p className={`text-[15px] font-semibold leading-snug ${cfg.text}`}>{answer}</p>
          <p className="mt-1 text-sm leading-snug text-[var(--text-secondary)]">{reason}</p>
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
