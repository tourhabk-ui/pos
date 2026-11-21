import Link from 'next/link';
import Logo from '@/components/shared/Logo';
import { Send } from 'lucide-react';
// Список ссылок — из реестра, общего со страницей «Ещё» (/menu, 02.09).
// Своего списка у футера больше нет: две копии одного меню расходятся так же,
// как расходились две SOS-кнопки. Ссылка на /mcp остаётся здесь по требованию
// сторожа mcp-landing — теперь через реестр.
//
// Группы берём из PLATFORM_SECTIONS (аудит вёрстки 21.11, A5): раньше все
// неправовые ссылки шли одной колонкой «Платформа» в два-три столбика без
// заголовков, и на телефоне это был список на два с половиной экрана с
// высотой ссылки 16–17 px.
import { PLATFORM_SECTIONS } from '@/lib/navigation/platform-links';

const CONTENT_SECTIONS = PLATFORM_SECTIONS.filter((s) => s.id !== 'legal');
const LEGAL = PLATFORM_SECTIONS.find((s) => s.id === 'legal')!.links;

const linkClass = 'inline-flex items-center min-h-11 text-sm text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors';

export function Footer() {
  return (
    <footer className="border-t border-[var(--border)] bg-[var(--bg-primary)]">
      <div className="mx-auto w-full max-w-[1280px] px-6 xl:px-8 py-12">
        <div>
            <Link href="/" className="inline-flex items-center gap-2.5 min-h-11 mb-2">
              <Logo size={32} className="shrink-0" />
              <span
                className="text-base font-semibold text-[var(--text-primary)]"
                style={{ fontFamily: 'var(--font-outfit)' }}
              >Ведар</span>
            </Link>
            <p className="text-sm text-[var(--text-secondary)] leading-relaxed max-w-xs">
              Ведар — полевой инструмент Камчатки. Маршруты, опасности, регистрация, SOS.
            </p>
            <p className="text-sm text-[var(--text-muted)] mt-4">
              info@vedarai.ru
            </p>
            <div className="flex flex-col gap-1 mt-3">
              <a
                href="https://t.me/kamchatka_real"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 min-h-11 text-sm text-[var(--ocean)] hover:underline transition-colors"
              >
                <Send className="w-3.5 h-3.5" />
                Telegram-канал
              </a>
              <a
                href="https://max.ru/id4101147649_biz"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 min-h-11 text-sm text-[var(--ocean)] hover:underline transition-colors"
              >
                <Send className="w-3.5 h-3.5" />
                Канал в MAX
              </a>
            </div>
        </div>

        <div className="mt-10 grid sm:grid-cols-2 xl:grid-cols-4 gap-10">
          {CONTENT_SECTIONS.map((section) => (
            <div key={section.id}>
              <p className="text-xs font-semibold uppercase tracking-widest text-[var(--text-muted)] mb-2">
                {section.title}
              </p>
              <ul className={`gap-x-6 [&>li]:break-inside-avoid ${section.links.length > 12 ? 'columns-2 xl:columns-1' : ''}`}>
                {section.links.map((item) => (
                  <li key={item.href}>
                    <Link href={item.href} className={linkClass}>
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-[var(--text-muted)] mb-2">
              Правовые документы
            </p>
            <ul>
              {LEGAL.map((item) => (
                <li key={item.href}>
                  <Link href={item.href} className={linkClass}>
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

        </div>

        {/* Статус платформы — решение владельца 05.10: информационная система,
            оплату не принимает (lib/payments/accepting). */}
        <p className="mt-10 text-sm leading-relaxed text-[var(--text-muted)] max-w-[70ch]">
          Ведар — информационная система: размещает сведения о маршрутах и турах и передаёт заявки
          операторам. Не является туроператором, турагентом или агрегатором и не принимает оплату —
          договор и расчёты за тур туристы заключают с оператором напрямую.
        </p>

        {/* Bottom bar */}
        <div className="mt-6 pt-6 border-t border-[var(--border)] flex flex-col sm:flex-row items-center justify-between gap-3">
          <p className="text-sm text-[var(--text-muted)]">
            © {new Date().getFullYear()} ООО «ПОС-СЕРВИС» (ИНН 4101147649). Все права защищены.
          </p>
          <div className="flex flex-wrap items-center gap-4">
            {/* Цвет — токен опасности: red-500 на светлом фоне давал 3,45:1
                (ниже AA 4,5), и на компьютере это единственное нарушение
                контраста главной (PageSpeed 20.11, #3564 п.6). */}
            <Link href="/sos" className="inline-flex items-center min-h-11 text-sm text-[var(--danger)] hover:underline font-semibold transition-colors">
              SOS
            </Link>
            <p className="text-sm text-[var(--text-muted)] max-w-[70ch]">
              683024, Камчатский край, г. Петропавловск-Камчатский
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}
