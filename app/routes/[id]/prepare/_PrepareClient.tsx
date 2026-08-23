'use client';

/**
 * «Подготовка к походу» — маршрутный план действий (план FCN, этап 4).
 *
 * Не чек-лист покупок, а семь потребностей выхода: что решить, зачем, что
 * уже готово. Сверху — 2–4 конкретных действия «Нужно решить до выхода»,
 * не сорок восемь галочек. «N из 7 доменов подготовлены» — статус
 * подготовки данных и задач, НЕ разрешение идти и не оценка безопасности:
 * слово всегда «подготовлены», зелёной галочки на весь экран нет,
 * при 7/7 сегменты не сливаются в одну полосу.
 *
 * Вид — по контракту «стекло для контекста, непрозрачность для действия»
 * (решение владельца 2026-08-15): тёмная топографическая подложка,
 * стеклянные шапка и готовые домены (fx-glass), плотные карточки действий
 * (fx-glass-dense). Фолбэк без blur — в globals.css.
 *
 * План живёт локально (anonymous-first): подготовка не требует регистрации.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Check, Compass, Info,
  Map as MapIcon, Mountain, Backpack, FolderOpen,
} from 'lucide-react';
import {
  buildPreparationItems, summarizeDomains, nextActions,
} from '@/lib/preparation/engine';
import {
  PREP_DOMAINS, type PrepAnswers, type PrepItem, type PrepState,
} from '@/lib/preparation/types';
import { loadPreparationPlan, savePreparationPlan } from '@/lib/preparation/storage';
import { loadFieldPack, verifyFieldPack, type PackAssetState } from '@/lib/offline/field-pack';
import { buildBriefingSnapshot } from '@/lib/preparation/briefing';
import { passportGradeLabel, type RoutePassport } from '@/lib/routes/passport';
import { PushSafetyOffer } from '@/components/PWA/PushSafetyOffer';

/** Тонкие изолинии подложки — рельеф кодом, без внешних картинок. */
function TopoBackground() {
  return (
    <svg className="fixed inset-0 w-full h-full pointer-events-none" aria-hidden="true"
      preserveAspectRatio="xMidYMid slice" viewBox="0 0 400 800">
      {[0, 1, 2, 3, 4, 5, 6, 7].map(i => (
        <path key={i}
          d={`M -50 ${90 + i * 95} C ${60 + i * 14} ${40 + i * 88}, ${210 - i * 10} ${150 + i * 92}, 460 ${70 + i * 96}`}
          fill="none" stroke="rgba(255,255,255,0.045)" strokeWidth="1.2" />
      ))}
      {[0, 1, 2, 3, 4].map(i => (
        <ellipse key={`e${i}`} cx={300 - i * 12} cy={170 + i * 10} rx={90 - i * 16} ry={40 - i * 7}
          fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
      ))}
    </svg>
  );
}

const QUESTIONS: Array<{
  key: keyof PrepAnswers;
  label: string;
  options: Array<{ value: string; label: string }>;
}> = [
  {
    key: 'duration',
    label: 'Сколько длится выход?',
    options: [
      { value: 'under_4h', label: 'До 4 часов' },
      { value: 'day', label: 'Один день' },
      { value: 'overnight', label: 'С ночёвкой' },
      { value: 'multi_day', label: 'Несколько дней' },
    ],
  },
  {
    key: 'party',
    label: 'Кто идёт?',
    options: [
      { value: 'solo', label: 'Один' },
      { value: 'group', label: 'Группа' },
      { value: 'guided', label: 'С гидом' },
    ],
  },
  {
    key: 'experience',
    label: 'Опыт похожих маршрутов?',
    options: [
      { value: 'first_time', label: 'Впервые' },
      { value: 'some', label: 'Иногда хожу' },
      { value: 'confident', label: 'Уверенно' },
    ],
  },
];

const DURATION_LABEL: Record<string, string> = {
  under_4h: 'До 4 часов', day: 'Один день', overnight: 'С ночёвкой', multi_day: 'Несколько дней',
};
const PARTY_LABEL: Record<string, string> = {
  solo: 'Один', group: 'Группа', guided: 'С гидом',
};

export default function PrepareClient({ routeId }: { routeId: string }) {
  const [title, setTitle] = useState<string | null>(null);
  const [passport, setPassport] = useState<RoutePassport | null>(null);
  const [packStates, setPackStates] = useState<PackAssetState[] | null>(null);
  const [conditionsAgeMs, setConditionsAgeMs] = useState<number | null>(null);
  const [answers, setAnswers] = useState<PrepAnswers>({});
  const [userStates, setUserStates] = useState<Record<string, PrepState>>({});
  const [showQuestions, setShowQuestions] = useState(false);
  const [loaded, setLoaded] = useState(false);
  /** Плановое время возврата — главное число брифинга для контакта. */
  const [returnBy, setReturnBy] = useState('');
  const [sharing, setSharing] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // План — из локального хранилища: подготовка переживает перезагрузку.
  useEffect(() => {
    const plan = loadPreparationPlan(routeId);
    if (plan) {
      setAnswers(plan.answers);
      setUserStates(plan.userStates);
    } else {
      // Первый заход — вопросы открыты: четыре уточнения, не анкета.
      setShowQuestions(true);
    }
    setLoaded(true);
  }, [routeId]);

  // Паспорт маршрута — источник правил доступа и рода линии.
  useEffect(() => {
    fetch(`/api/routes/${routeId}`)
      .then(r => r.json())
      .then((j: unknown) => {
        if (typeof j !== 'object' || j === null || !(j as Record<string, unknown>).success) return;
        const data = (j as Record<string, unknown>).data as Record<string, unknown>;
        setTitle((data.title as string) ?? null);
        setPassport((data.passport as RoutePassport | undefined) ?? null);
      })
      .catch(() => { /* офлайн: план работает по пакету и сохранённым ответам */ });
  }, [routeId]);

  // Полевой пакет — факт, не клик: состояние из манифеста.
  useEffect(() => {
    loadFieldPack(routeId)
      .then(async pack => {
        if (!pack) { setPackStates(null); setConditionsAgeMs(null); return; }
        setPackStates(await verifyFieldPack(pack));
        setConditionsAgeMs(pack.safety && !pack.safety.unavailable ? Date.now() - pack.safety.at : null);
      })
      .catch(() => { setPackStates(null); setConditionsAgeMs(null); });
  }, [routeId]);

  const persist = useCallback((a: PrepAnswers, us: Record<string, PrepState>) => {
    savePreparationPlan({
      routeId,
      routeVersion: passport?.version ?? 1,
      answers: a,
      userStates: us,
      updatedAt: Date.now(),
    });
  }, [routeId, passport]);

  const setAnswer = useCallback((key: keyof PrepAnswers, value: string) => {
    setAnswers(prev => {
      const next = { ...prev, [key]: value } as PrepAnswers;
      persist(next, userStates);
      return next;
    });
  }, [persist, userStates]);

  const confirmItem = useCallback((item: PrepItem) => {
    setUserStates(prev => {
      const next: Record<string, PrepState> = { ...prev, [item.code]: 'ready' };
      persist(answers, next);
      return next;
    });
  }, [persist, answers]);


  const items = useMemo(() => buildPreparationItems({
    passport, packStates, answers, conditionsAgeMs, userStates,
  }), [passport, packStates, answers, conditionsAgeMs, userStates]);

  const domains = useMemo(() => summarizeDomains(items), [items]);
  const actions = useMemo(() => nextActions(items), [items]);
  const preparedCount = domains.filter(d => d.prepared).length;
  const readyItems = useMemo(
    () => items.filter(i => i.state === 'ready' || i.state === 'not_applicable'),
    [items],
  );

  /**
   * Создать ссылку-брифинг. Отправляет её человек сам — мы не собираем
   * контактных данных получателя и не обещаем слежения: в снимке нет и не
   * может быть координат (схема API их не принимает).
   */
  const shareBriefing = useCallback(async () => {
    if (sharing) return;
    setSharing(true);
    setShareError(null);
    try {
      const snapshot = buildBriefingSnapshot({
        routeTitle: title ?? 'Маршрут',
        routeVersion: passport?.version ?? 1,
        routeGrade: passportGradeLabel(passport?.grade ?? 'unknown'),
        waypointsCount: passport?.waypointsCount ?? 0,
        departureAt: null,
        returnBy: returnBy || null,
        answers,
        packStates,
        domains,
        openActionTitles: actions.map(a => a.title),
      });
      const res = await fetch('/api/preparation/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          routeId,
          routeVersion: passport?.version ?? 1,
          returnBy: returnBy ? new Date(returnBy).toISOString() : null,
          answers,
          snapshot,
        }),
      });
      const json = await res.json() as { success?: boolean; data?: { path: string; expiresAt: string }; error?: string };
      if (!res.ok || !json.success || !json.data) {
        setShareError(json.error ?? 'Не удалось создать ссылку');
        return;
      }
      const url = `${window.location.origin}${json.data.path}`;
      setShareUrl(url);
      // Отметка «сделано» ставится по факту созданной ссылки, а не по клику.
      setUserStates(prev => {
        const next: Record<string, PrepState> = { ...prev, return_plan: 'ready' };
        persist(answers, next);
        return next;
      });
      try { await navigator.clipboard.writeText(url); setCopied(true); } catch { /* без буфера — ссылка на экране */ }
    } catch {
      setShareError('Нет связи — ссылку можно создать позже, пока есть интернет');
    } finally {
      setSharing(false);
    }
  }, [sharing, title, passport, returnBy, answers, packStates, domains, actions, routeId, persist]);

  const metaLine = [
    answers.duration ? DURATION_LABEL[answers.duration] : null,
    answers.party ? PARTY_LABEL[answers.party] : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className="min-h-screen relative" style={{ background: '#0b1014', color: '#F0F6FC' }}>
      <TopoBackground />

      <div className="relative max-w-lg mx-auto px-4 pb-28 pt-4">
        {/* Навигация назад — к карточке маршрута */}
        <div className="flex items-center gap-3 mb-4">
          <Link href={`/routes/${routeId}`} aria-label="К маршруту"
            className="w-10 h-10 rounded-lg flex items-center justify-center fx-glass">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <h1 className="text-lg font-bold flex-1" style={{ fontFamily: 'var(--font-playfair)' }}>
            Подготовка к походу
          </h1>
        </div>

        {/* Шапка маршрута — стекло: контекст поверх рельефа */}
        <div className="fx-glass rounded-2xl p-4 mb-5">
          <p className="text-base font-bold" style={{ fontFamily: 'var(--font-playfair)' }}>
            {title ?? 'Маршрут'}
          </p>
          {metaLine && (
            <p className="text-xs mt-0.5" style={{ color: 'rgba(240,246,252,0.65)' }}>{metaLine}</p>
          )}
          {/* Статус доменов: это состояние подготовки, не разрешение идти.
              Слово всегда «подготовлены»; сегменты раздельны и при 7/7. */}
          <div className="flex items-center gap-3 mt-3">
            <div className="w-10 h-10 rounded-full flex items-center justify-center shrink-0"
              style={{ border: '2px solid rgba(255,255,255,0.25)' }}>
              <Mountain className="w-5 h-5" style={{ color: 'rgba(240,246,252,0.8)' }} />
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold">
                {preparedCount} из {PREP_DOMAINS.length} доменов подготовлены
              </p>
              <div className="flex gap-1 mt-1.5">
                {domains.map(d => (
                  <span key={d.domain} title={d.label}
                    className="h-1.5 rounded-full flex-1"
                    style={{ background: d.prepared ? 'var(--success)' : 'rgba(255,255,255,0.18)' }} />
                ))}
              </div>
            </div>
          </div>
          <button onClick={() => setShowQuestions(v => !v)}
            className="text-xs font-semibold mt-3 underline underline-offset-2"
            style={{ color: 'var(--ocean)' }}>
            {showQuestions ? 'Свернуть уточнения' : 'Уточнить выход'}
          </button>
        </div>

        {/* Четыре уточнения — не анкета: можно пропустить, план станет точнее */}
        {showQuestions && loaded && (
          <div className="fx-glass rounded-2xl p-4 mb-5 space-y-3.5">
            {QUESTIONS.map(q => (
              <div key={q.key}>
                <p className="text-xs font-semibold mb-1.5" style={{ color: 'rgba(240,246,252,0.7)' }}>{q.label}</p>
                <div className="flex flex-wrap gap-1.5">
                  {q.options.map(o => {
                    const active = answers[q.key] === o.value;
                    return (
                      <button key={o.value} onClick={() => setAnswer(q.key, o.value)}
                        className="text-xs font-medium px-3 py-1.5 rounded-lg transition-colors duration-200"
                        style={active
                          ? { background: 'color-mix(in srgb, var(--success) 18%, transparent)', color: 'var(--success)', border: '1px solid color-mix(in srgb, var(--success) 40%, transparent)' }
                          : { background: 'rgba(255,255,255,0.06)', color: 'rgba(240,246,252,0.75)', border: '1px solid rgba(255,255,255,0.12)' }}>
                        {o.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            <p className="text-[11px] flex items-start gap-1.5" style={{ color: 'rgba(240,246,252,0.5)' }}>
              <Info className="w-3.5 h-3.5 shrink-0 mt-px" />
              Ответы уточняют план: ночёвка добавляет укрытие и запас, группа — роли и связь
            </p>
          </div>
        )}

        {/* Нужно решить до выхода: 2–4 действия, карточки ПЛОТНЫЕ —
            действие не платит за красоту контрастом */}
        {actions.length > 0 && (
          <>
            <h2 className="text-base font-bold mb-3" style={{ fontFamily: 'var(--font-playfair)' }}>
              Нужно решить до выхода
            </h2>
            <div className="space-y-3 mb-6">
              {actions.map(item => (
                <div key={item.code} className="fx-glass-dense rounded-2xl p-4"
                  style={{ borderColor: 'color-mix(in srgb, var(--warning) 45%, transparent)' }}>
                  <div className="flex items-center gap-3">
                    <div className="w-11 h-11 rounded-full flex items-center justify-center shrink-0"
                      style={{ border: '1.5px solid var(--warning)', color: 'var(--warning)' }}>
                      {item.action?.kind === 'open_field_pack' ? <MapIcon className="w-5 h-5" />
                        : item.action?.kind === 'open_registration' ? <Compass className="w-5 h-5" />
                        : item.action?.kind === 'open_equipment' ? <Backpack className="w-5 h-5" />
                        : <FolderOpen className="w-5 h-5" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold leading-snug">{item.title}</p>
                      {item.meta && (
                        <p className="text-xs mt-0.5" style={{ color: 'rgba(240,246,252,0.55)' }}>{item.meta}</p>
                      )}
                    </div>
                    {item.action && (item.action.href ? (
                      item.action.href.startsWith('http') ? (
                        <a href={item.action.href} target="_blank" rel="noopener noreferrer"
                          className="text-xs font-bold px-3.5 py-2 rounded-lg shrink-0"
                          style={{ color: 'var(--warning)', border: '1px solid var(--warning)' }}>
                          {item.action.label}
                        </a>
                      ) : (
                        <Link href={item.action.href}
                          className="text-xs font-bold px-3.5 py-2 rounded-lg shrink-0"
                          style={{ color: 'var(--warning)', border: '1px solid var(--warning)' }}>
                          {item.action.label}
                        </Link>
                      )
                    ) : null)}
                    {item.action?.kind === 'manual_confirm' && !item.action.href && (
                      <button onClick={() => confirmItem(item)}
                        className="text-xs font-bold px-3.5 py-2 rounded-lg shrink-0"
                        style={{ color: 'var(--warning)', border: '1px solid var(--warning)' }}>
                        {item.action.label}
                      </button>
                    )}
                    {item.action?.kind === 'share_briefing' && (
                      <button onClick={() => void shareBriefing()} disabled={sharing}
                        className="text-xs font-bold px-3.5 py-2 rounded-lg shrink-0 disabled:opacity-60"
                        style={{ color: 'var(--warning)', border: '1px solid var(--warning)' }}>
                        {sharing ? 'Создаём…' : item.action.label}
                      </button>
                    )}
                  </div>

                  {/* Время возврата — то, по чему контакт поймёт, что пора
                      звонить. Спрашиваем здесь же: без него брифинг теряет
                      главное число. */}
                  {item.action?.kind === 'share_briefing' && (
                    <div className="mt-3">
                      <label className="text-xs block mb-1" style={{ color: 'rgba(240,246,252,0.7)' }}>
                        Когда ждать обратно
                      </label>
                      <input type="datetime-local" value={returnBy}
                        onChange={e => setReturnBy(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg text-sm"
                        style={{
                          background: 'rgba(255,255,255,0.06)',
                          border: '1px solid rgba(255,255,255,0.15)',
                          color: '#F0F6FC',
                        }} />
                      {shareUrl && (
                        <div className="mt-2 p-2.5 rounded-lg" style={{ background: 'rgba(255,255,255,0.06)' }}>
                          <p className="text-[11px] mb-1" style={{ color: 'var(--success)' }}>
                            {copied ? 'Ссылка скопирована — отправьте её контакту' : 'Ссылка готова — отправьте её контакту'}
                          </p>
                          <p className="text-[11px] break-all" style={{ color: 'rgba(240,246,252,0.75)' }}>{shareUrl}</p>
                        </div>
                      )}
                      {shareError && (
                        <p className="text-[11px] mt-1.5" style={{ color: 'var(--danger)' }}>{shareError}</p>
                      )}
                    </div>
                  )}

                  <p className="text-xs mt-2.5 pt-2.5 flex items-start gap-1.5"
                    style={{ color: 'rgba(240,246,252,0.6)', borderTop: '1px solid rgba(255,255,255,0.1)' }}>
                    <Info className="w-3.5 h-3.5 shrink-0 mt-px" />
                    {item.reason}
                  </p>
                </div>
              ))}
            </div>
          </>
        )}

        {/* Уже готово — лёгкое стекло с зелёной кромкой */}
        {readyItems.length > 0 && (
          <>
            <h2 className="text-base font-bold mb-3" style={{ fontFamily: 'var(--font-playfair)' }}>
              Уже готово
            </h2>
            <div className="space-y-2">
              {readyItems.map(item => (
                <div key={item.code}
                  className="fx-glass rounded-xl px-4 py-3 flex items-center gap-3"
                  style={{ borderColor: 'color-mix(in srgb, var(--success) 35%, transparent)' }}>
                  <Check className="w-4 h-4 shrink-0" style={{ color: 'var(--success)' }} />
                  <p className="text-sm flex-1">{item.title}</p>
                </div>
              ))}
            </div>
          </>
        )}

        {/* Предупреждения о безопасности — здесь, а не только на /safety.
            Watchdog 23.08: подписчиков 0, 18 предупреждений не ушло. Механика
            была цела, не работало расположение: предложение стояло там, куда
            заходят УЖЕ решив позаботиться. Момент подписки — этот: человек
            готовится к конкретному маршруту и ещё в сети.

            Ниже блока не ставим ничего: предложение идёт ПОСЛЕ списка того,
            что осталось сделать, и не спорит с ним за внимание. Компонент сам
            исчезает, когда предлагать нечего. */}
        <div className="mt-6">
          <PushSafetyOffer />
        </div>
      </div>

      {/* Нижние переходы: Обзор активен; Снаряжение и Пакет — существующие
          инструменты, не заглушки. Вкладка «Группа» появится с шарингом. */}
      <nav className="fixed bottom-0 inset-x-0 fx-glass" style={{ borderLeft: 'none', borderRight: 'none', borderBottom: 'none' }}>
        <div className="max-w-lg mx-auto grid grid-cols-3 text-center text-[11px]">
          <span className="py-3 font-semibold" style={{ color: 'var(--success)' }}>
            <Compass className="w-5 h-5 mx-auto mb-0.5" />
            Обзор
          </span>
          <Link href={`/tools/equipment?routeId=${routeId}`} className="py-3" style={{ color: 'rgba(240,246,252,0.6)' }}>
            <Backpack className="w-5 h-5 mx-auto mb-0.5" />
            Снаряжение
          </Link>
          <Link href="/planning?mode=trail" className="py-3" style={{ color: 'rgba(240,246,252,0.6)' }}>
            <MapIcon className="w-5 h-5 mx-auto mb-0.5" />
            Пакет
          </Link>
        </div>
      </nav>
      {/* Явное: цифра доменов — не оценка безопасности маршрута и не
          «можно идти». Продукт таких обещаний не делает нигде. */}
    </div>
  );
}
