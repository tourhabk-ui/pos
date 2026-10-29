/**
 * «Прогноз Камчатского УГМС» на /weather — официальный суточный прогноз
 * синоптиков по районам, дословно, рядом с числами модели
 * (lib/weather/ugms-forecast; владелец 29.10: «есть же камчатский гидромет»).
 *
 * Три исхода (§4.0): прогноз на ближайшие дни есть — текст с датой, районом и
 * временем чтения; на эти дни прогноза у нас нет — так и сказано (это не
 * «погода спокойная»); не прочитан — «сбой», не пустота. Между 56° и 57,5°
 * граница районов УГМС не названа — показаны оба блока с пометкой.
 */
import { CloudSun } from 'lucide-react';
import { kamchatkaTime } from '@/lib/weather/weather-format';
import { UGMS_BASE, UGMS_SOURCE_LABEL, UGMS_ZONE_LABELS, ugmsDayLabel, type UgmsRead } from '@/lib/weather/ugms-forecast';

export function UgmsForecast({ read, today, scene = false }: { read: UgmsRead; today: string; scene?: boolean }) {
  const muted = scene ? 'text-[var(--wx-fg-2)]' : 'text-[var(--text-secondary)]';
  const strong = scene ? 'text-[var(--wx-fg)]' : 'text-[var(--text-primary)]';
  const link = scene ? 'text-[var(--wx-fg)] underline underline-offset-2' : 'text-[var(--ocean)]';
  const box = scene ? 'wx-glass rounded-[1.5rem]' : 'rounded-3xl border border-[var(--border)] bg-[var(--bg-card)]';
  const dayWord = (date: string) => {
    const t = new Date(`${today}T00:00:00Z`).getTime();
    const d = new Date(`${date}T00:00:00Z`).getTime();
    const diff = Math.round((d - t) / 86_400_000);
    return diff === 0 ? 'Сегодня' : diff === 1 ? 'Завтра' : ugmsDayLabel(date);
  };
  const source = (
    <a href={UGMS_BASE} target="_blank" rel="noopener noreferrer" className={link}>{UGMS_SOURCE_LABEL}</a>
  );
  return (
    <section className={`flex flex-col gap-3 p-4 sm:p-5 ${box}`} aria-labelledby="weather-ugms">
      <h2 id="weather-ugms" className={`flex items-center gap-2 text-base font-semibold ${strong}`}>
        <CloudSun size={18} aria-hidden />
        Прогноз Камчатского УГМС
      </h2>
      {read.kind === 'failed' ? (
        <p className={`text-sm ${muted}`}>Прогноз синоптиков сейчас не прочитался: {read.reason}. Это сбой у нас, а не отсутствие прогноза.</p>
      ) : read.items.length === 0 ? (
        <p className={`text-sm ${muted}`}>
          Прогноза синоптиков на ближайшие дни у нас сейчас нет: он не прочитан с сайта {source}. Это не значит, что погода спокойная.
        </p>
      ) : (
        <>
          {read.ambiguous ? (
            <p className={`text-sm ${muted}`}>
              Граница южных и северных районов в прогнозе не названа, поэтому показаны оба — место между ними.
            </p>
          ) : null}
          <ul className="flex flex-col gap-3">
            {read.items.map((i) => (
              <li key={`${i.date}/${i.zone}`} className="flex flex-col gap-1">
                <p className={`text-sm font-medium ${strong}`}>
                  {dayWord(i.date)}, {ugmsDayLabel(i.date)} · {UGMS_ZONE_LABELS[i.zone]}
                </p>
                <p className={`text-sm ${strong}`}>{i.text}</p>
                {i.notes.map((n) => <p key={n} className={`text-sm ${muted}`}>{n}</p>)}
              </li>
            ))}
          </ul>
          <p className={`text-xs ${muted}`}>
            Источник — {source}, прогноз синоптиков дословно
            {read.items[0].fetchedAt ? `; прочитан ${kamchatkaTime(read.items[0].fetchedAt)} по Камчатке` : ''}.
            Числа выше — расчёт модели, это другой источник.
          </p>
        </>
      )}
    </section>
  );
}
