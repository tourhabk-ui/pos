'use client';

import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { sessionState } from '@/lib/auth/session-state';
import { planEntryHref } from '@/lib/planner/plan-entry';

/**
 * Ссылка «Собрать план»: гостю — план в чате Кузьмича, вошедшему — /planner
 * (lib/planner/plan-entry). Пока вход не проверен, ссылка ведёт в чат: он
 * открывается без входа.
 */
export function PlanEntryLink(props: {
  className?: string;
  style?: React.CSSProperties;
  'aria-label'?: string;
  children: ReactNode;
}) {
  const [authed, setAuthed] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    sessionState().then((v) => { if (alive) setAuthed(v); });
    return () => { alive = false; };
  }, []);
  return (
    <Link href={planEntryHref(authed)} className={props.className} style={props.style} aria-label={props['aria-label']}>
      {props.children}
    </Link>
  );
}
