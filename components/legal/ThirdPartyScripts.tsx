'use client';

/**
 * Третьи скрипты грузятся только после согласия — и только те, что объявлены.
 *
 * ── Что было до 11.09 ─────────────────────────────────────────────────────
 *
 * `YandexMetrika`, `MicrosoftClarity` и `TravelPayoutsDrive` стояли в
 * `app/layout.tsx` безусловно: данные посетителя уходили трём получателям с
 * первой же секунды первой страницы, до любого вопроса. Баннера согласия в
 * репозитории не было ни одного, Clarity не был назван в политике вовсе, а
 * TP Drive — рекламное размещение без токена erid.
 *
 * Здесь одна точка входа вместо трёх: состав берётся из
 * `lib/legal/third-party-registry`, решение о загрузке — из `loadDecision`,
 * и тот же реестр рендерится в политике. Разойтись «что грузится» и «о чём
 * сказано» больше нечем.
 *
 * ── Почему баннер непрозрачный ────────────────────────────────────────────
 *
 * DS §5: стекло — для контекста, непрозрачность — для действия. Здесь человек
 * принимает решение о своих данных; это действие, а не декорация, и читаться
 * оно обязано при любом фоне под ним.
 */

import { useEffect, useState } from 'react';
import Script from 'next/script';
import { ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { THIRD_PARTIES, loadDecision } from '@/lib/legal/third-party-registry';
import { readConsent, writeConsent, type ConsentChoice } from '@/lib/legal/consent';

const ALL_DENIED: ConsentChoice = { analytics: false, advertising: false };

export default function ThirdPartyScripts() {
  // До монтирования на клиенте согласия НЕТ по определению: на сервере
  // localStorage не существует, и рендерить скрипты «на всякий случай»
  // значило бы отправить данные до ответа.
  const [choice, setChoice] = useState<ConsentChoice>(ALL_DENIED);
  const [asked, setAsked] = useState(true);

  useEffect(() => {
    const { state, choice: stored } = readConsent();
    setChoice(stored);
    setAsked(state !== 'unknown');
  }, []);

  function decide(next: ConsentChoice) {
    writeConsent(next);
    setChoice(next);
    setAsked(true);
  }

  const allowed = THIRD_PARTIES.filter((tp) => loadDecision(tp, choice).load);

  return (
    <>
      {allowed.map((tp) => (
        <ThirdPartyTag key={tp.id} id={tp.id} />
      ))}

      {!asked && (
        <div
          role="dialog"
          aria-labelledby="consent-title"
          className="fixed inset-x-0 bottom-0 z-[60] p-3 sm:p-4"
        >
          <div className="mx-auto max-w-3xl rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4 shadow-lg sm:p-5">
            <div className="flex items-start gap-3">
              <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-[var(--ocean)]" aria-hidden />
              <div className="min-w-0">
                <p id="consent-title" className="font-semibold text-[var(--text-primary)]">
                  Аналитика и партнёрские сервисы
                </p>
                <p className="mt-1 text-sm text-[var(--text-secondary)]">
                  Мы хотим подключить сервисы, которые записывают, как вы пользуетесь сайтом,
                  и показывают предложения партнёров. Часть из них передаёт данные за пределы
                  России. Без вашего согласия они не загружаются — сайт работает и так.
                </p>
                <p className="mt-2 text-sm text-[var(--text-muted)]">
                  Кто именно и зачем —{' '}
                  <Link href="/legal/privacy" className="text-[var(--ocean)] underline">
                    в политике конфиденциальности
                  </Link>
                  . Решение можно изменить там же.
                </p>

                <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                  <button
                    type="button"
                    onClick={() => decide({ analytics: true, advertising: true })}
                    className="ds-btn ds-btn-primary min-h-[44px] px-4"
                  >
                    Разрешить
                  </button>
                  <button
                    type="button"
                    onClick={() => decide(ALL_DENIED)}
                    className="ds-btn ds-btn-secondary min-h-[44px] px-4"
                  >
                    Только необходимое
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Сам тег. Разметка каждого сервиса живёт здесь, рядом с реестром, а не в
 * трёх отдельных компонентах: иначе реестр снова разойдётся с тем, что
 * реально грузится.
 */
function ThirdPartyTag({ id }: { id: string }) {
  if (id === 'YandexMetrika') {
    const metrikaId = process.env.NEXT_PUBLIC_YANDEX_METRIKA_ID ?? '103522218';
    if (!metrikaId) return null;
    return (
      <Script id="yandex-metrika" strategy="afterInteractive">
        {`
          (function(m,e,t,r,i,k,a){m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};
          m[i].l=1*new Date();
          for(var j=0;j<document.scripts.length;j++){if(document.scripts[j].src===r){return;}}
          k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,a.parentNode.insertBefore(k,a)})
          (window,document,"script","https://mc.yandex.ru/metrika/tag.js","ym");
          ym(${metrikaId},"init",{clickmap:true,trackLinks:true,accurateTrackBounce:true,webvisor:true});
        `}
      </Script>
    );
  }

  if (id === 'MicrosoftClarity') {
    const clarityId = process.env.NEXT_PUBLIC_CLARITY_ID;
    if (!clarityId) return null;
    return (
      <Script
        id="microsoft-clarity"
        strategy="afterInteractive"
        dangerouslySetInnerHTML={{
          __html: `
            (function(c,l,a,r,i,t,y){
              c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
              t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
              y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
            })(window, document, "clarity", "script", "${clarityId}");
          `,
        }}
      />
    );
  }

  if (id === 'TravelPayoutsDrive') {
    // Сюда исполнение не доходит, пока у записи в реестре нет erid:
    // `loadDecision` отсекает рекламу без токена раньше. Ветка оставлена,
    // чтобы при появлении токена не пришлось вспоминать разметку.
    return (
      <Script id="tp-drive" strategy="afterInteractive">
        {`(function(){var s=document.createElement("script");s.async=1;s.src="https://emrldco.com/NTEzNDg4.js?t=513488";document.head.appendChild(s);})();`}
      </Script>
    );
  }

  return null;
}
