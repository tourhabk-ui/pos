import Link from 'next/link';
import { operatorPagePath } from '@/lib/operators/page-link';

/**
 * Имя оператора как ссылка на его страницу — везде, где оно показано туристу
 * (решение владельца 13.10). Страницы нет (карточка закрыта или без адреса)
 * — то же имя текстом, без ссылки на 404. Серверный компонент: без хуков,
 * годится и в server-, и в client-деревьях.
 */
export function OperatorNameLink({
  name,
  slug,
  isPublic,
  className,
  children,
}: {
  name: string;
  slug?: string | null;
  isPublic?: boolean | null;
  className?: string;
  children?: React.ReactNode;
}) {
  const href = operatorPagePath({ slug, is_public: isPublic });
  const content = children ?? name;
  if (!href) return <span className={className}>{content}</span>;
  return (
    <Link
      href={href}
      className={`${className ?? ''} hover:text-[var(--accent)] hover:underline underline-offset-2 transition-colors duration-200`.trim()}
      title={`Страница оператора «${name}»`}
    >
      {content}
    </Link>
  );
}
