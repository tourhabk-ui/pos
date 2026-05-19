'use client';

import Link from 'next/link';
import { ArrowUpRight, MessageCircle, Map, Shield } from 'lucide-react';

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
  { Icon: Map, text: 'Составит маршрут под ваш бюджет и даты' },
  { Icon: Shield, text: 'Предупредит о закрытых и опасных участках' },
  { Icon: MessageCircle, text: 'Ответит на любой вопрос о Камчатке' },
];

export function MessengerAgentsSection() {
  return (
    <section
      id="chat"
      className="bg-[var(--bg-card)] rounded-lg border border-[var(--border)] p-6 md:p-8 flex flex-col h-full"
    >
      <p className="text-[10px] uppercase tracking-[0.25em] text-[var(--accent)] font-semibold mb-4">
        AI-консьерж
      </p>

      <h3
        className="font-playfair font-bold text-[var(--text-primary)] leading-snug mb-3"
        style={{ fontSize: 'clamp(1.5rem, 2.5vw, 2rem)' }}
      >
        Кузьмич знает<br />
        всю Камчатку
      </h3>

      <p className="text-sm text-[var(--text-secondary)] leading-relaxed mb-6">
        Расскажите, что вас интересует, — он соберёт план, подберёт оператора
        и предупредит о реальных опасностях на маршруте.
      </p>

      <ul className="flex flex-col gap-3 mb-7">
        {ABILITIES.map(({ Icon, text }) => (
          <li key={text} className="flex items-start gap-3">
            <div className="w-7 h-7 rounded-md bg-[var(--accent)]/10 flex items-center justify-center shrink-0 mt-0.5">
              <Icon size={14} className="text-[var(--accent)]" />
            </div>
            <span className="text-sm text-[var(--text-secondary)] leading-snug">{text}</span>
          </li>
        ))}
      </ul>

      <div className="mt-auto">
        <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--text-muted)] font-medium mb-2.5">
          Открыть в
        </p>
        <div className="flex flex-col gap-2">
          {CHANNELS.map(({ title, href, Icon, external }) => {
            const cls =
              'flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] px-4 py-2.5 hover:bg-[var(--bg-hover)] hover:border-[var(--accent)]/30 transition-all duration-200 group';
            const inner = (
              <>
                <Icon className="h-6 w-6 shrink-0" />
                <span className="text-sm font-semibold text-[var(--text-primary)]">{title}</span>
                <ArrowUpRight className="h-3.5 w-3.5 text-[var(--text-muted)] ml-auto group-hover:text-[var(--accent)] transition-colors duration-200" />
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
    </section>
  );
}
