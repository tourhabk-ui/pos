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

import { Suspense, useEffect, useRef, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import Script from 'next/script';
import { ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { THIRD_PARTIES, loadDecision } from '@/lib/legal/third-party-registry';
import { readConsent, writeConsent, type ConsentChoice } from '@/lib/legal/consent';
import { isWidgetPath } from '@/lib/embed/widget-frame';
import { metrikaHit, metrikaInitScript, muteWebvisorFields, shouldTrackPath } from '@/lib/analytics/metrika';

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

  const pathname = usePathname();

  // Виджет партнёра (iframe на его сайте): посетитель пришёл к партнёру, а не
  // к Ведару. Ни баннера — он закрывал имя и телефон в форме заявки, — ни
  // счётчиков: Метрика в iframe писала визит Ведару за каждый просмотр
  // чужой страницы (примерка на fishingkam.ru 29.09).
  if (isWidgetPath(pathname)) return null;

  const allowed = THIRD_PARTIES.filter((tp) => loadDecision(tp, choice).load);

  return (
    <>
      {allowed.map((tp) => (
        <ThirdPartyTag key={tp.id} id={tp.id} pathname={pathname} />
      ))}

      {!asked && (
        <div
          role="dialog"
          aria-labelledby="consent-title"
          className={
            'pointer-events-none fixed inset-x-0 bottom-0 z-[60] p-3 sm:p-4 ' +
            'pb-[calc(env(safe-area-inset-bottom)+116px)] ' +
            'sm:pb-[calc(env(safe-area-inset-bottom)+72px)]'
          }
          /*
           * Отступ снизу поднимает карточку НАД липкими полосами телефона.
           *
           * 14.09, снимок карточки места на 390×844: SOS-полоса (z-[100],
           * выше этого диалога намеренно — SOS всегда сверху) перекрывала
           * низ карточки согласия, и кнопка «Только необходимое» оказывалась
           * под ней ПРИ ЛЮБОЙ прокрутке. То есть на телефоне у человека
           * оставалась ровно одна доступная кнопка — «Разрешить».
           *
           * Это не только неудобство: согласие, которое нельзя так же просто
           * НЕ дать, согласием не является. Поднимать диалог выше SOS нельзя
           * (сторож sos-always-reachable), поэтому он уступает место сам.
           * Клиренс считан по двум полосам карточки места — SOS (~52px со
           * safe-area) и бар с GPX (~58px); на страницах, где полос меньше,
           * карточка просто висит чуть выше.
           *
           * Обёртка прозрачна для касаний (pointer-events-none), карточка —
           * нет (pointer-events-auto). Иначе прозрачный отступ ловил тапы по
           * тому, что под ним: на карточке тура при первом визите «Выбрать
           * дату» в нижней панели не нажималась вовсе (аудит П1, #28/#88).
           * Сторож: tests/unit/legal-disclosure.test.ts.
           */
        >
          <div className="pointer-events-auto mx-auto max-w-3xl rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4 shadow-lg sm:p-5">
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

                {/* Кнопки в строку и на телефоне: столбиком карточка была на
                    две строки выше, а места на телефоне и так нет. Обе — одного
                    размера, чтобы отказ не выглядел второстепенным. */}
                <div className="mt-4 flex flex-row flex-wrap gap-2">
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
function ThirdPartyTag({ id, pathname }: { id: string; pathname: string | null }) {
  if (id === 'YandexMetrika') {
    // Кабинеты, вход, брони, контроль выхода и офлайн-контур счётчик не
    // видят — список с причинами в lib/analytics/metrika.ts.
    if (!shouldTrackPath(pathname)) return null;
    // Пикселя для noscript здесь нет намеренно: без JavaScript согласие
    // прочитать нельзя, а хит без согласия — то, от чего этот компонент
    // и защищает.
    return (
      <>
        <Script id="yandex-metrika" strategy="afterInteractive">
          {metrikaInitScript()}
        </Script>
        <Suspense fallback={null}>
          <MetrikaRouteHits />
        </Suspense>
        <WebvisorFieldGuard />
      </>
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

/**
 * Переход внутри приложения — просмотр страницы. Первый просмотр отправляет
 * сам `init` (`ssr:true` с `url`), поэтому первый запуск эффекта только
 * запоминает адрес; каждый следующий адрес уходит хитом с прежним как
 * referer.
 */
function MetrikaRouteHits() {
  const pathname = usePathname();
  const search = useSearchParams();
  const previous = useRef<string | null>(null);
  useEffect(() => {
    const url = window.location.href;
    if (previous.current === null) {
      previous.current = url;
      return;
    }
    if (previous.current === url) return;
    metrikaHit(url, previous.current);
    previous.current = url;
  }, [pathname, search]);
  return null;
}

/**
 * Вебвизор не записывает содержимое полей с классом `ym-disable-keys`.
 * Класс ставится на поля с ПД при монтировании и на всё, что появляется в
 * DOM позже (модальные формы, шаги планера); если перерисовка React сняла
 * класс вместе с className — наблюдатель атрибутов вернёт его.
 */
function WebvisorFieldGuard() {
  useEffect(() => {
    muteWebvisorFields(document);
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'attributes' && m.target instanceof Element) muteWebvisorFields(m.target);
        m.addedNodes.forEach((n) => {
          if (n instanceof Element) muteWebvisorFields(n);
        });
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return null;
}
