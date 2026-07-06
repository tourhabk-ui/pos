/**
 * BearIcon — кастомная иконка медведя для кнопки Кузьмича (Field OS nav).
 * Тот же визуальный язык, что и lucide-react (stroke=currentColor, viewBox 24x24,
 * size/color-пропы), но лицом Камчатки, а не общего робота — Кузьмич не
 * абстрактный бот, а камчатский голос платформы.
 */

interface BearIconProps {
  size?: number;
  color?: string;
  className?: string;
}

export function BearIcon({ size = 24, color = 'currentColor', className }: BearIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="7" cy="6" r="3" />
      <circle cx="17" cy="6" r="3" />
      <path d="M12 8a6 6 0 0 0-6 6v4a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-4a6 6 0 0 0-6-6z" />
      <circle cx="10" cy="14" r="1" fill={color} />
      <circle cx="14" cy="14" r="1" fill={color} />
      <path d="M12 17v1" />
    </svg>
  );
}

export default BearIcon;
