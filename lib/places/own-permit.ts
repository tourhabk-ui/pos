/**
 * Своё разрешение места — куда вести человека за правом быть на территории.
 *
 * До 14.10 карточка места на любую строку «регистрация обязательна» вешала
 * «Разрешение парка → Зелёная кнопка». Кнопка — приложение сети природных
 * парков «Вулканы Камчатки» (lib/safety/park-permit.ts), и для их троп это
 * правда. Кроноцкий заповедник (миграция 1240) — другое учреждение с другим
 * порядком: заявка с kronoki.ru на почту заповедника. Своя записанная
 * страница разрешения (`places.eco_permit_url`) поэтому важнее общей кнопки.
 */

export interface OwnPermit {
  /** «Разрешение заповедника» / «Разрешение заказника» / «Разрешение парка». */
  label: string;
  href: string;
  /** Что видно в ссылке — хост страницы, без схемы и www. */
  host: string;
}

const PERMIT_LABEL_BY_ZONE: Record<string, string> = {
  federal_reserve: 'Разрешение заповедника',
  regional_reserve: 'Разрешение заповедника',
  national_park: 'Разрешение национального парка',
  zakaznik: 'Разрешение заказника',
};

/** Своё разрешение места из эко-данных; адреса нет или он не https — null. */
export function ownPermitOf(eco: { zone: string | null; permitUrl: string | null } | null | undefined): OwnPermit | null {
  if (!eco?.permitUrl) return null;
  let url: URL;
  try {
    url = new URL(eco.permitUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  return {
    label: PERMIT_LABEL_BY_ZONE[eco.zone ?? ''] ?? 'Разрешение парка',
    href: url.toString(),
    host: url.hostname.replace(/^www\./, ''),
  };
}
