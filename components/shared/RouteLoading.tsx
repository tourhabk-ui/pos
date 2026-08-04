/**
 * Скелетон перехода — общий для страниц, куда ведёт навигация.
 *
 * Полевой прогон 04.08 (EDGE): переходы с главной выглядели как «ничего не
 * происходит». App Router до готовности серверного компонента держит СТАРЫЙ
 * экран, и без `loading.tsx` у страницы нет ни одного признака работы: на
 * быстром вайфае это незаметно, на честной горной связи — десятки секунд
 * молчания, после которых турист жмёт ещё раз. `loading.tsx` было у 6 страниц
 * из 210.
 *
 * Отсюда правило: у страницы, куда ведёт таб-бар или блок безопасности главной,
 * скелетон обязателен. Сторож — `tests/unit/navigation-loading.test.ts`.
 */
export default function RouteLoading({ withHero = false }: { withHero?: boolean }) {
  return (
    <div className="ds-page" style={{ paddingTop: '80px' }} role="status" aria-label="Загрузка страницы">
      <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">
        <div className="ds-skeleton h-9 w-2/3 rounded" />
        <div className="ds-skeleton h-5 w-1/2 rounded" />
        {withHero && <div className="ds-skeleton h-56 rounded-2xl" />}
        <div className="space-y-3">
          <div className="ds-skeleton h-24 rounded-xl" />
          <div className="ds-skeleton h-24 rounded-xl" />
          <div className="ds-skeleton h-24 rounded-xl" />
        </div>
      </div>
    </div>
  );
}
