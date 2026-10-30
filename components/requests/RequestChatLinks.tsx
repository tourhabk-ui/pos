'use client';

/**
 * Ссылки человеку после отправки заявки (1349, 1350): страница заявки с
 * перепиской и подключение MAX, чтобы ответы адресата приходили туда. Одна
 * вёрстка на все формы: жильё, машина у перевозчика, прокат, заявка компании
 * (страница, её сайт, виджет).
 *
 * Ключ заявки стоит в адресе обеих ссылок, а формы живут на страницах со
 * счётчиком Метрики: Вебвизор записывает страницу, «внешние ссылки» — адреса
 * переходов. Поэтому это кнопки: адрес — в обработчике нажатия, а не в
 * разметке, и в запись не попадает (ревью 30.10). Сама страница заявки
 * счётчик не грузит (lib/analytics/metrika).
 *
 * Ссылок нет (ключ не выдался) — так и сказано, а не пустое место (§4.0):
 * заявка принята, переписки на сайте не будет, адресат позвонит.
 */
export function RequestChatLinks({ page, maxLink, newTab = false }: {
  page: string | null;
  maxLink: string | null;
  /** Форма в чужом окне (виджет на сайте партнёра) — страница заявки в новой вкладке. */
  newTab?: boolean;
}) {
  if (!page) {
    return (
      <p className="text-xs text-[var(--text-muted)]">
        Ссылка на переписку не выдалась — сбой на нашей стороне. Вам позвонят по телефону из заявки.
      </p>
    );
  }
  const open = (url: string, tab: boolean) => {
    if (tab) window.open(url, '_blank', 'noopener,noreferrer');
    else window.open(url, '_self');
  };
  return (
    <div className="space-y-2">
      <button type="button" className="ds-btn ds-btn-primary w-full" onClick={() => open(page, newTab)}>
        Переписка по заявке
      </button>
      {maxLink && (
        <button type="button" className="ds-btn ds-btn-secondary w-full" onClick={() => open(maxLink, true)}>
          Получать ответы в MAX
        </button>
      )}
      <p className="text-xs text-[var(--text-muted)]">
        Откроется страница заявки — сохраните её в закладки: там видны ответы и можно написать. Никому её не пересылайте.
      </p>
    </div>
  );
}
