/**
 * 112 и простой экран SOS на каждом экране ошибки.
 *
 * 21.11 владелец открыл сайт на экране в машине (старый Chrome на Android).
 * /sos упал в «Произошла ошибка» с кнопками «Попробовать снова» и «На
 * главную», а главная — в «Страница не догрузилась». Шапки с кнопкой SOS на
 * таких экранах нет: корневая граница рисует свой документ, а граница
 * раздела закрывает собой всю страницу. Человек, у которого упала страница,
 * оставался без экстренного вызова.
 *
 * Поэтому экран ошибки — не тупик: на каждом есть звонок 112 и ссылка на
 * `/emergency` — страницу без React и без сети (лежит в прекэше
 * service worker'а, её скрипты разбирает и старый браузер).
 *
 * Только ссылки, без кнопок: кнопка на экране ошибки одна — повтор или
 * обновление страницы. Ссылки жёсткие (`<a>`), не `next/link`: `/emergency` —
 * готовый HTML, его отдаёт документ, а не роутер. Номер — из
 * `lib/safety/emergency-numbers.ts`. Стили встроенные: корневая граница
 * рисует блок, когда стили сайта могли не прийти; без них ссылки остаются
 * обычными ссылками и работают.
 *
 * Сторож: tests/unit/error-screens-emergency.test.tsx.
 */
import { EMERGENCY_PRIMARY } from '@/lib/safety/emergency-numbers';

/** Страница SOS без зависимостей: GPS, звонок, протоколы. */
export const EMERGENCY_SCREEN_PATH = '/emergency';

export const ERROR_EMERGENCY_TEXT = {
  call: `Экстренный вызов — ${EMERGENCY_PRIMARY.phone}`,
  screen: 'Экран SOS: координаты и звонок, работает без сети',
} as const;

export function ErrorEmergencyLinks({ prominent = false }: { prominent?: boolean }) {
  return (
    <nav
      aria-label="Экстренная помощь"
      style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: prominent ? 0 : '1.5rem' }}
    >
      <a
        href={`tel:${EMERGENCY_PRIMARY.phone}`}
        style={{
          display: 'block',
          padding: prominent ? '1rem 1.25rem' : '0.75rem 1rem',
          minHeight: '44px',
          borderRadius: '0.5rem',
          background: 'var(--danger)',
          color: 'var(--on-danger)',
          fontWeight: 700,
          fontSize: prominent ? '1.25rem' : '1rem',
          textDecoration: 'none',
          textAlign: 'center',
        }}
      >
        {ERROR_EMERGENCY_TEXT.call}
      </a>
      <a
        href={EMERGENCY_SCREEN_PATH}
        style={{
          display: 'block',
          padding: '0.75rem 1rem',
          minHeight: '44px',
          borderRadius: '0.5rem',
          border: '1px solid var(--danger)',
          color: 'var(--danger)',
          fontWeight: 600,
          textDecoration: 'none',
          textAlign: 'center',
        }}
      >
        {ERROR_EMERGENCY_TEXT.screen}
      </a>
    </nav>
  );
}
