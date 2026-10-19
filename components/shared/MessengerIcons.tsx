import { useId } from 'react';

/**
 * Официальные знаки мессенджеров для кнопок Кузьмича.
 *
 * Telegram — фирменный знак из простого глифа Telegram (круг и самолёт),
 * заливка фирменным #2AABEE (тот же цвет, что токен --telegram).
 * MAX — фирменный знак из официального брендбука MAX (go.max.ru/brandbook,
 * файл «Max colored.svg»): силуэт знака без изменений, градиент собран из
 * фирменных цветов MAX (#471AFF, #9500FF, #00BFFF). Знаки лежат инлайн,
 * чтобы не тянуть внешние картинки и не зависеть от чужих CDN.
 */
export function TelegramIcon({ size = 22, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true" focusable="false">
      <path
        fill="#2AABEE"
        d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"
      />
    </svg>
  );
}

export function MaxIcon({ size = 22, className = '' }: { size?: number; className?: string }) {
  const gradientId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none" className={className} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={gradientId} x1="8" y1="92" x2="92" y2="8" gradientUnits="userSpaceOnUse">
          <stop stopColor="#00BFFF" />
          <stop offset="0.48" stopColor="#471AFF" />
          <stop offset="1" stopColor="#9500FF" />
        </linearGradient>
      </defs>
      <path
        fill={`url(#${gradientId})`}
        fillRule="evenodd"
        clipRule="evenodd"
        d="M50.7571 0.261719C78.2929 0.261719 99.8857 22.5974 99.8857 50.1474C99.8857 77.6974 77.6071 99.4903 51.0214 99.4903C41.5857 99.4903 37.0143 98.1617 29.65 92.9474C29.1429 92.5903 28.45 92.6831 28.0214 93.1403C22.3571 99.1831 7.85 103.426 7.18571 95.176C7.18571 80.7903 0 71.4474 0 49.876C0 21.5546 23.2214 0.261719 50.7571 0.261719ZM51.5286 24.8117C38.4643 24.126 28.2643 33.1974 26.0143 47.3831C24.15 59.1332 27.45 73.4546 30.2786 74.176C31.4786 74.4832 34.3571 72.276 36.4571 70.2974C36.85 69.926 37.45 69.8617 37.9071 70.1474C41.1786 72.1474 44.8786 73.6474 48.9571 73.8617C62.3714 74.5617 74.2571 64.0617 74.9643 50.6474C75.6643 37.2331 64.9429 25.5046 51.5286 24.8046V24.8117Z"
      />
    </svg>
  );
}

import { VEDAR_MARK_PATH } from '@/components/shared/Logo';

/**
 * Фирменный знак официального чата Ведара.
 *
 * Исходник — официальный знак Ведара: силуэт Камчатки из шапки сайта
 * (components/shared/Logo, мастер-файл public/brand/vedar-mark.svg, тот же
 * знак, что на иконке приложения public/brand/vedar-icon.svg). Знак не
 * перерисован: контур берётся из VEDAR_MARK_PATH без изменений.
 *
 * Обыгран как чат так: силуэт помещён внутрь речевого пузыря с хвостиком
 * внизу слева. Пузырь — белый с фирменной акцентной обводкой
 * (var(--accent), в мастер-файле #E86A06), силуэт — тем же акцентом.
 * Белый пузырь поэтому читается и на акцентной кнопке «Спросить на сайте»,
 * и на светлой карточке, и на тёмной панели; силуэт внутри остаётся
 * фирменным знаком, а не generic-«конвертом». На 20–28px силуэт сохраняет
 * вытянутую форму полуострова, пузырь и хвостик не теряются.
 */
export function VedarChatIcon({ size = 24, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      className={className}
      aria-hidden="true"
      focusable="false"
      data-vedar-chat-icon="true"
    >
      <path
        d="M24 4.5c-10.8 0-19.5 7.9-19.5 17.6 0 5.4 2.8 10.3 7.2 13.7v6.1c0 1.3 1.4 2.1 2.5 1.4l7.4-4.6c.8.1 1.6.2 2.4.2 10.8 0 19.5-7.9 19.5-17.6S34.8 4.5 24 4.5Z"
        fill="#FFFFFF"
        stroke="var(--accent)"
        strokeWidth="2.6"
        strokeLinejoin="round"
      />
      <g transform="translate(16.1 9.2) scale(0.069)">
        <path d={VEDAR_MARK_PATH} fill="var(--accent)" />
      </g>
    </svg>
  );
}
