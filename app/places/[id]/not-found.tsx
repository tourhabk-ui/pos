import Link from 'next/link';

/**
 * 404 карточки места. До 10.09 несуществующее место отдавало HTTP 200 с
 * надписью «не найдено» внутри клиента (#1776): для поисковика и внешнего
 * монитора это была живая страница. Теперь page.tsx зовёт notFound(), а
 * этот экран — её честный ответ.
 */
export default function PlaceNotFound() {
  return (
    <div
      className="min-h-screen flex items-center justify-center p-6"
      style={{ backgroundColor: 'var(--bg-primary)' }}
    >
      <div className="text-center max-w-md">
        <p className="text-6xl font-bold mb-4" style={{ color: 'var(--text-muted)' }}>404</p>
        <h1 className="text-xl font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
          Место не найдено
        </h1>
        <p className="text-sm mb-8" style={{ color: 'var(--text-muted)' }}>
          Такого места нет на карте, или оно было скрыто.
        </p>
        <div className="flex gap-3 justify-center">
          <Link href="/map" className="ds-btn ds-btn-primary">
            Карта мест
          </Link>
          <Link href="/" className="ds-btn ds-btn-secondary">
            На главную
          </Link>
        </div>
      </div>
    </div>
  );
}
