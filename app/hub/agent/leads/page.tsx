import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Заявки | Кабинет агента',
  robots: 'noindex, nofollow',
};

/**
 * Заявки платформы агентам закрыты (26.09): это персональные данные туристов,
 * а роль агента выдаётся самостоятельной регистрацией. Страница оставлена,
 * чтобы старые ссылки не вели в 404, и честно говорит, почему пусто.
 */
export default function AgentLeadsPage() {
  return (
    <div className="ds-card p-6 space-y-3 max-w-xl">
      <h1 className="ds-h2">Заявки платформы</h1>
      <p className="text-sm text-[var(--text-secondary)]">
        Заявки туристов с сайта агентам недоступны: в них персональные данные, и доступ к ним
        есть только у платформы и оператора тура.
      </p>
      <p className="text-sm text-[var(--text-secondary)]">
        Своих клиентов ведите в разделе <Link href="/hub/agent/clients" className="text-[var(--ocean)] underline">«Клиенты»</Link>,
        а туры для них ищите в <Link href="/hub/agent/find" className="text-[var(--ocean)] underline">«Найти тур»</Link>.
      </p>
    </div>
  );
}
