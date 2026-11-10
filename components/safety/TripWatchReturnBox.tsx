'use client';

/**
 * Рамка «отметьте возвращение» на экране после включения контроля.
 *
 * Вынесена из app/register/page.tsx ради сторожа: экран формы тяжёлый, а слова
 * этой рамки решают, что человек сделает, вернувшись с маршрута, — их судит
 * рендер (tests/unit/return-not-to-mchs.test.tsx), а не чтение исходника.
 *
 * Две вещи, которые здесь нельзя слить в одну:
 *  - контроль возвращения Ведара: не отметился к сроку — тревога контакту и
 *    дежурному Ведара; закрывается кнопкой «Я вернулся»;
 *  - контроль группы в МЧС: его ведёт МЧС по заявке человека, и Ведар туда не
 *    сообщает (манифест контроля выхода, правило 4).
 * Рамка называлась «Сообщите о возвращении» и говорила только о кнопке. Тот,
 * кто подал и заявку в МЧС, нажимал её и считал, что сообщил всем.
 */

import { useState } from 'react';
import { MCHS_AFTER_RETURN, MCHS_RETURN_NOT_VIA_VEDAR } from '@/lib/safety/mchs-registration';

interface Props {
  registrationId: string;
  /** Дата возвращения, как её ввёл человек. */
  endDate: string;
  /** Время возвращения; пусто — контрольное время 20:00. */
  expectedReturnTime: string;
}

export default function TripWatchReturnBox({ registrationId, endDate, expectedReturnTime }: Props) {
  // Три исхода, а не два: «не скопировалось» человек должен увидеть — иначе он
  // уйдёт на маршрут без ссылки, которой закрывают контроль (§4.0).
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const href = `/return?id=${registrationId}`;

  const copyLink = () => {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (!clipboard) { setCopy('failed'); return; }
    clipboard.writeText(`${window.location.origin}${href}`)
      .then(() => setCopy('copied'))
      .catch(() => setCopy('failed'));
  };

  return (
    <div className="p-4 rounded-lg bg-[var(--bg-card)] border border-[var(--success)] mb-6 text-left">
      <p className="font-semibold text-sm mb-1">Отметьте возвращение в Ведаре</p>
      <p className="text-xs text-[var(--text-muted)] mb-3">
        {expectedReturnTime
          ? `Контрольное время: ${endDate} в ${expectedReturnTime}.`
          : `Контрольное время: ${endDate} до 20:00.`}{' '}
        Если к нему не отметиться, тревога уйдёт вашему экстренному контакту —
        в Telegram или на почту, если вы их указали; если нет — дежурному Ведара,
        чтобы он позвонил контакту. Напоминание вам самим не придёт: сохраните
        ссылку и по возвращении нажмите «Я вернулся».
      </p>
      <p className="text-xs font-medium text-[var(--text-primary)] mb-2">
        Кнопка закрывает только контроль Ведара. {MCHS_RETURN_NOT_VIA_VEDAR}
      </p>
      <p className="text-xs text-[var(--text-muted)] mb-3">{MCHS_AFTER_RETURN}</p>
      <div className="flex gap-2">
        <a
          href={href}
          className="flex-1 py-2.5 rounded-lg bg-[var(--success)] text-white text-center font-semibold text-sm hover:opacity-90"
        >
          Страница «Я вернулся»
        </a>
        <button
          type="button"
          onClick={copyLink}
          className="px-4 py-2.5 rounded-lg border border-[var(--border)] text-sm font-medium hover:bg-[var(--bg-hover)]"
        >
          {copy === 'copied' ? 'Скопировано' : 'Копировать'}
        </button>
      </div>
      {copy === 'failed' && (
        <p className="mt-2 text-xs text-[var(--warning)]" role="status">
          Ссылка не скопировалась — откройте страницу «Я вернулся» и сохраните её адрес.
        </p>
      )}
    </div>
  );
}
