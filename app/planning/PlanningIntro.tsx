/**
 * Видимый H1 и вводный текст /planning — серверной разметкой (22.11): поиск
 * и человек без JS видят, что это за страница. Имя — lib/navigation/tool-names.
 * Здесь нет слов «план поездки» и «на N дней»: это /planner и /plans.
 */
import Link from 'next/link';
import { PLANNING_NAME } from '@/lib/navigation/tool-names';

export function PlanningIntro() {
  return (
    <header className="space-y-3" data-planning-intro>
      <h1 className="font-playfair text-2xl sm:text-3xl font-bold text-[var(--text-primary)]">{PLANNING_NAME}</h1>
      <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
        Здесь готовятся к выходу на маршрут: находят место и тропу к нему, проверяют снаряжение по списку
        и сохраняют карту района, чтобы она открывалась без интернета. За городом связь на Камчатке
        часто пропадает, поэтому карту и список лучше подготовить дома, пока сеть есть.
      </p>
      <details className="text-sm text-[var(--text-secondary)]">
        <summary className="cursor-pointer font-medium text-[var(--text-primary)]">Как подготовиться</summary>
        <ol className="list-decimal pl-5 mt-2 space-y-1.5 leading-relaxed">
          <li>Найдите место или маршрут в поиске ниже и откройте его карточку: там описание, сложность и точки на карте.</li>
          <li>Пройдите чек-лист: снаряжение по сезону, регистрация группы в МЧС, телефоны экстренных служб. Форма МЧС открывается из списка, подаёте её вы сами.</li>
          <li>Сохраните карту района на телефон и перед выходом откройте вкладку «На маршруте»: она показывает трек и ваше место на нём без сети.</li>
        </ol>
        <p className="mt-2 leading-relaxed">
          Отметки чек-листа хранятся только в этом браузере, вход для них не нужен. Погоду и обстановку проверьте
          в день выхода: сводки МЧС меняются быстрее, чем любой список.
        </p>
      </details>
      <p className="text-xs text-[var(--text-muted)]">
        Нужна поездка с турами местных операторов? <Link href="/planner" className="text-[var(--ocean)] hover:underline">Соберите её с Кузьмичом</Link>{' '}
        или посмотрите <Link href="/plans" className="text-[var(--ocean)] hover:underline">готовые маршруты</Link>.
      </p>
    </header>
  );
}
