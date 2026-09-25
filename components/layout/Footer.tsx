import Link from 'next/link';
import Image from 'next/image';
import { Send } from 'lucide-react';
// Список ссылок — из реестра, общего со страницей «Ещё» (/menu, 02.09).
// Своего списка у футера больше нет: две копии одного меню расходятся так же,
// как расходились две SOS-кнопки. Ссылка на /mcp остаётся здесь по требованию
// сторожа mcp-landing — теперь через реестр.
import { PLATFORM_LINKS as PLATFORM, LEGAL_LINKS as LEGAL } from '@/lib/navigation/platform-links';

export function Footer() {
  return (
    <footer className="border-t border-[var(--border)] bg-[var(--bg-primary)]">
      <div className="mx-auto w-full max-w-[1280px] px-6 xl:px-8 py-12">
        {/* Сетка шириной главной (lib/home/desktop-layout); длинный список
            «Платформа» — колонками, а не одной лентой на 40 строк (25.09). */}
        <div className="grid md:grid-cols-4 lg:grid-cols-6 gap-10">

          {/* Brand */}
          <div className="md:col-span-1 lg:col-span-2">
            <Link href="/" className="flex items-center gap-2.5 mb-4">
              <Image
                src="/logo-kamchatka.svg"
                alt="Ведар"
                width={32}
                height={32}
                className="shrink-0"
              />
              <span
                className="text-base font-semibold text-[var(--text-primary)]"
                style={{ fontFamily: 'var(--font-outfit)' }}
              >Ведар</span>
            </Link>
            <p className="text-sm text-[var(--text-secondary)] leading-relaxed max-w-xs">
              Ведар — полевой инструмент Камчатки. Маршруты, опасности, регистрация, SOS.
            </p>
            <p className="text-xs text-[var(--text-muted)] mt-4">
              info@vedarai.ru
            </p>
<div className="flex flex-col gap-2 mt-3">
              <a
                href="https://t.me/kamchatourhub"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-[var(--ocean)] hover:underline transition-colors"
              >
                <Send className="w-3.5 h-3.5" />
                Telegram-канал
              </a>
              <a
                href="https://max.ru/id4101147649_biz"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-[var(--ocean)] hover:underline transition-colors"
              >
                <Send className="w-3.5 h-3.5" />
                Канал в MAX
              </a>
            </div>
          </div>

          {/* Platform links */}
          <div className="md:col-span-2 lg:col-span-3">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-[var(--text-muted)] mb-4">
              Платформа
            </p>
            <ul className="columns-2 lg:columns-3 gap-x-8 [&>li]:mb-2.5 [&>li]:break-inside-avoid">
              {PLATFORM.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className="text-sm text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors"
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Legal links */}
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-[var(--text-muted)] mb-4">
              Правовые документы
            </p>
            <ul className="space-y-2.5">
              {LEGAL.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className="text-sm text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors"
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

        </div>

        {/* Bottom bar */}
        <div className="mt-10 pt-6 border-t border-[var(--border)] flex flex-col sm:flex-row items-center justify-between gap-3">
          <p className="text-xs text-[var(--text-muted)]">
            © {new Date().getFullYear()} ООО «ПОС-СЕРВИС» (ИНН 4101147649). Все права защищены.
          </p>
          <div className="flex items-center gap-4">
            <Link href="/sos" className="text-xs text-red-500 hover:text-red-400 font-semibold transition-colors">
              SOS
            </Link>
            <p className="text-xs text-[var(--text-muted)]">
              683024, Камчатский край, г. Петропавловск-Камчатский
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}
