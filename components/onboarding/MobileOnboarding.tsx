'use client';

/**
 * MobileOnboarding — 4 экрана для нового пользователя (только mobile).
 * Показывается один раз (localStorage 'kh-onboarded'), свайп/кнопки,
 * «Пропустить» на каждом шаге. Слайд про Кузьмича обучает жесту long-press
 * СОС — фича невидима без подсказки (решение владельца: СОС без отдельной
 * кнопки).
 *
 * Фоны — наши фото Камчатки, текст на glass-панели (разрешено поверх фото,
 * CLAUDE.md §2). Иконки lucide, без emoji. Анимации — Tailwind-транзишены.
 */

import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { ShieldCheck, Bot, Download, UserRound, ChevronRight } from 'lucide-react';

const STORAGE_KEY = 'kh-onboarded';
const SWIPE_THRESHOLD_PX = 60;

const SLIDES = [
  {
    icon: ShieldCheck,
    title: 'Безопасность — прежде всего',
    text: 'Радар показывает реальную обстановку на маршрутах: алерты КБГС и МЧС, статусы троп, наблюдения других туристов. Ничего не выдумываем — только проверенные данные с указанием источника и свежести.',
    image: '/images/hero/IMG_20260316_133026.jpg',
  },
  {
    icon: Bot,
    title: 'Кузьмич — ваш проводник',
    text: 'Спросите голосом или текстом: маршрут на 2 дня, где медведи, что взять с собой. Кнопка Кузьмича — в центре нижней панели. Удержите её 600 мс — мгновенно откроется экстренный экран СОС.',
    image: '/images/hero/IMG_20260316_133113.jpg',
  },
  {
    icon: Download,
    title: 'Карты работают без связи',
    text: 'На Камчатке сети часто нет. Скачайте карты и маршруты заранее — навигация, треки и СОС-инструкции будут доступны офлайн даже в глуши.',
    image: '/images/hero/hero-dark.jpeg',
  },
  {
    icon: UserRound,
    title: 'Профиль под вашу подготовку',
    text: 'Укажите уровень опыта — Кузьмич будет советовать маршруты по силам, а брони и избранные места соберутся в личном кабинете.',
    image: '/images/hero/IMG_20260316_133133.jpg',
  },
] as const;

export function MobileOnboarding() {
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState(0);
  const touchStartX = useRef<number | null>(null);

  useEffect(() => {
    try {
      if (!localStorage.getItem(STORAGE_KEY)) setVisible(true);
    } catch { /* приватный режим без localStorage — онбординг не показываем */ }
  }, []);

  const finish = () => {
    try { localStorage.setItem(STORAGE_KEY, '1'); } catch { /* ок */ }
    setVisible(false);
  };

  const next = () => {
    if (step >= SLIDES.length - 1) finish();
    else setStep(s => s + 1);
  };

  const onTouchStart = (e: React.TouchEvent) => { touchStartX.current = e.touches[0].clientX; };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current === null) return;
    const delta = e.changedTouches[0].clientX - touchStartX.current;
    touchStartX.current = null;
    if (delta < -SWIPE_THRESHOLD_PX) next();
    else if (delta > SWIPE_THRESHOLD_PX && step > 0) setStep(s => s - 1);
  };

  if (!visible) return null;

  const slide = SLIDES[step];
  const Icon = slide.icon;
  const isLast = step === SLIDES.length - 1;

  return (
    <div
      className="fixed inset-0 z-[130] md:hidden"
      role="dialog"
      aria-modal="true"
      aria-label="Знакомство с платформой"
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <Image
        key={slide.image}
        src={slide.image}
        alt=""
        fill
        priority
        sizes="100vw"
        className="object-cover"
      />
      <div className="absolute inset-0 bg-gradient-to-b from-black/50 via-black/20 to-black/80" aria-hidden />

      <button
        type="button"
        onClick={finish}
        className="absolute right-4 top-4 z-10 rounded-full border border-white/25 backdrop-blur-md bg-black/40 px-4 py-1.5 text-sm text-white transition-all duration-200 active:scale-95"
      >
        Пропустить
      </button>

      <div className="absolute inset-x-0 bottom-0 z-10 p-5 pb-10">
        <div className="rounded-2xl border border-white/15 backdrop-blur-md bg-black/40 p-6">
          <span className="flex h-12 w-12 items-center justify-center rounded-full border border-white/20 bg-white/10">
            <Icon size={24} strokeWidth={1.5} className="text-white" aria-hidden />
          </span>
          <h2 className="mt-4 font-playfair text-2xl font-bold leading-tight text-white">
            {slide.title}
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-white/75">
            {slide.text}
          </p>

          <div className="mt-5 flex items-center justify-between">
            <div className="flex gap-1.5" aria-label={`Шаг ${step + 1} из ${SLIDES.length}`}>
              {SLIDES.map((_, i) => (
                <span
                  key={i}
                  aria-hidden
                  className="h-1.5 rounded-full transition-all duration-200"
                  style={{
                    width: i === step ? 20 : 6,
                    background: i === step ? 'var(--accent)' : 'rgba(255,255,255,0.35)',
                  }}
                />
              ))}
            </div>
            <button
              type="button"
              onClick={next}
              className="flex items-center gap-1 rounded-full bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold text-white transition-all duration-200 active:scale-95"
            >
              {isLast ? 'Начать' : 'Далее'}
              {!isLast && <ChevronRight size={16} strokeWidth={2} aria-hidden />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default MobileOnboarding;
