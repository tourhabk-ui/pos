'use client';

import Link from 'next/link';
import { ArrowUpRight, Map, Shield, MessageCircle } from 'lucide-react';

function TelegramIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="12" cy="12" r="12" fill="#229ED9" />
      <path
        d="M5.49 11.64l11.52-4.44c.53-.19 1 .13.83.95l-1.96 9.22c-.14.66-.53.82-1.08.51l-2.99-2.2-1.44 1.39c-.16.16-.3.3-.6.3l.21-3.02 5.5-4.97c.24-.21-.05-.33-.37-.12l-6.8 4.28-2.93-.92c-.64-.2-.65-.64.13-.95z"
        fill="#fff"
      />
    </svg>
  );
}

function MaxIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect width="24" height="24" rx="5" fill="#FF7A00" />
      <path d="M6 17V7h2.3l3.7 5.5L15.7 7H18v10h-2.2v-6.6l-3.2 4.8h-1.2L8.2 10.4V17H6z" fill="#fff" />
    </svg>
  );
}

function WebIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="12" cy="12" r="12" fill="#0EA5E9" />
      <g stroke="#fff" strokeWidth="1.3" fill="none" strokeLinecap="round">
        <circle cx="12" cy="12" r="7" />
        <path d="M5 12h14" />
        <path d="M12 5c2.6 2.8 2.6 11.2 0 14M12 5c-2.6 2.8-2.6 11.2 0 14" />
      </g>
    </svg>
  );
}

const CHANNELS = [
  { title: 'Telegram', href: 'https://t.me/KuzmichKam_bot?start=homepage', Icon: TelegramIcon, external: true },
  { title: 'MAX', href: 'https://max.ru/id4101147649_bot', Icon: MaxIcon, external: true },
  { title: 'На сайте', href: '/ai-assistant', Icon: WebIcon, external: false },
];

const ABILITIES = [
  { Icon: Map, text: 'Составит маршрут с учётом сложности, сезона и погоды' },
  { Icon: Shield, text: 'Предупредит о закрытых зонах и реальных опасностях' },
  { Icon: MessageCircle, text: 'Ответит на любой вопрос о Камчатке 24/7' },
];

export function MessengerAgentsSection() {
  return (
    <section className="border-y border-[var(--border)] bg-[var(--bg-card)]">
      <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-[55%_45%]">

        {/* Left: identity + channels */}
        <div className="px-4 md:px-12 py-14 md:py-20 border-b md:border-b-0 md:border-r border-[var(--border)]">
          <div className="w-8 h-px bg-[var(--accent)] mb-7" />
          <p className="text-[10px] uppercase tracking-[0.3em] text-[var(--accent)] font-semibold mb-4">
            AI-консьерж
          </p>
          <h2
            className="font-playfair font-bold text-[var(--text-primary)] leading-[1.08] mb-5"
            style={{ fontSize: 'clamp(1.9rem, 3vw, 2.6rem)' }}
          >
            Кузьмич знает{' '}
            <em className="italic text-[var(--accent)]">всю Камчатку</em>
          </h2>
          <p className="text-[var(--text-secondary)] text-sm leading-relaxed mb-9 max-w-sm">
            Расскажите куда хотите — он соберёт маршрут, проверит статус точек
            и предупредит о закрытых или опасных участках.
          </p>

          <p className="text-[9px] uppercase tracking-[0.22em] text-[var(--text-muted)] font-medium mb-3">
            Открыть в
          </p>
          <div className="flex flex-col gap-2 max-w-xs">
            {CHANNELS.map(({ title, href, Icon, external }) => {
              const cls =
                'flex items-center gap-3 border border-[var(--border)] bg-[var(--bg-primary)] px-4 py-3 hover:border-[var(--accent)]/40 hover:bg-[var(--bg-hover)] transition-all duration-300 group';
              const inner = (
                <>
                  <Icon className="h-6 w-6 shrink-0" />
                  <span className="text-sm font-semibold text-[var(--text-primary)]">{title}</span>
                  <ArrowUpRight className="h-3.5 w-3.5 text-[var(--text-muted)] ml-auto group-hover:text-[var(--accent)] transition-colors duration-300" />
                </>
              );
              if (external) {
                return (
                  <a key={title} href={href} target="_blank" rel="noopener noreferrer" className={cls}>
                    {inner}
                  </a>
                );
              }
              return (
                <Link key={title} href={href} className={cls}>
                  {inner}
                </Link>
              );
            })}
          </div>
        </div>

        {/* Right: abilities editorial list */}
        <div className="px-4 md:px-12 py-14 md:py-20 flex flex-col justify-center">
          <ul className="flex flex-col">
            {ABILITIES.map(({ Icon, text }, i) => (
              <li key={i} className="border-t border-[var(--border)] py-6 flex items-start gap-4">
                <div className="w-7 h-7 border border-[var(--accent)]/25 flex items-center justify-center shrink-0 mt-0.5">
                  <Icon size={13} className="text-[var(--accent)]" />
                </div>
                <span className="text-sm text-[var(--text-secondary)] leading-snug">{text}</span>
              </li>
            ))}
            <li className="border-t border-[var(--border)]" />
          </ul>
        </div>

      </div>
    </section>
  );
}
