import type { Metadata } from 'next';
import { Header } from '@/components/layout/Header';
import {
  Leaf, Map, Footprints, Trash2, Mountain, Eye, Users, BookOpen,
} from 'lucide-react';

export const metadata: Metadata = {
  title: 'Экотуризм на Камчатке — памятка бережного путешествия',
  description:
    'Семь принципов осознанного путешествия по Камчатке: подготовка маршрута, тропы и стоянки, мусор, дикие животные, ООПТ и уважение к местной культуре.',
  keywords: [
    'экотуризм Камчатка',
    'правила поведения на природе Камчатка',
    'Leave No Trace Камчатка',
    'ООПТ Камчатка правила',
    'медведи Камчатка поведение',
    'бережное путешествие',
  ],
  openGraph: {
    title: 'Экотуризм: путешествуйте и сохраняйте природу',
    description:
      'Осознанный подход помогает сохранить первозданную красоту Камчатки. Семь принципов бережного путешествия.',
    url: 'https://vedarai.ru/eco',
    siteName: 'Ведар',
    locale: 'ru_RU',
    type: 'article',
  },
  alternates: { canonical: 'https://vedarai.ru/eco' },
};

interface Principle {
  icon: React.ReactNode;
  title: string;
  points: string[];
}

const PRINCIPLES: Principle[] = [
  {
    icon: <Map className="w-5 h-5" />,
    title: 'Планируйте маршрут заранее',
    points: [
      'Узнайте специфику региона: какие места требуют разрешения на посещение (например, ООПТ), где оборудованы стоянки и как меняется погода в разное время года.',
      'Проверьте карту местности и оцените свои силы.',
      'Подберите правильную экипировку.',
    ],
  },
  {
    icon: <Footprints className="w-5 h-5" />,
    title: 'Следуйте подготовленным маршрутам',
    points: [
      'Передвигайтесь только по специальным тропам.',
      'Разбивайте стоянку на специально отведённых площадках.',
      'Если планируете разводить костёр — выбирайте только разрешённые места и соблюдайте правила пожарной безопасности.',
    ],
  },
  {
    icon: <Trash2 className="w-5 h-5" />,
    title: 'Забирайте мусор с собой и будьте осознанны в быту',
    points: [
      'Уносите весь свой мусор — даже органический.',
      'Используйте мыло и бытовую химию вдали от водоёмов: почва может служить естественным фильтром, но лучше вообще отказаться от химии.',
      'Для туалета в дикой природе выкопайте небольшую ямку вдали от троп и водотоков, после использования засыпьте её.',
      'Мойте посуду в проточной воде, применяя натуральные абразивы — песок или мелкую гальку.',
    ],
  },
  {
    icon: <Mountain className="w-5 h-5" />,
    title: 'Не оставляйте следов и не нарушайте целостность природы',
    points: [
      'Не вырезайте надписи на деревьях и не оставляйте посланий на камнях.',
      'Не забирайте «сувениры» из природы — камни, растения, раковины и другие элементы ландшафта. Исключение — научные исследования с соответствующим разрешением.',
      'Старайтесь не менять окружающую среду: не ломайте ветки, не сдвигайте камни и не создавайте новых троп.',
    ],
  },
  {
    icon: <Eye className="w-5 h-5" />,
    title: 'Уважайте дикую природу',
    points: [
      'Наблюдайте за животными издалека.',
      'Не прикармливайте диких животных: это меняет их поведение и может привести к опасным ситуациям.',
      'Не трогайте и не разрушайте гнёзда, норы и другие жилища — они жизненно важны для выживания видов.',
      'Избегайте купания в незнакомых водоёмах.',
    ],
  },
  {
    icon: <Users className="w-5 h-5" />,
    title: 'Уважайте местных жителей и их культуру, поддерживайте ООПТ',
    points: [
      'Относитесь с вниманием к традициям и образу жизни местных людей.',
      'Соблюдайте правила, установленные на особо охраняемых природных территориях, и благодарите сотрудников за их труд.',
    ],
  },
  {
    icon: <BookOpen className="w-5 h-5" />,
    title: 'Учитесь и просвещайтесь',
    points: [
      'Читайте информационные стенды, слушайте гидов и изучайте материалы о регионе — это сделает поездку глубже и интереснее.',
      'Делитесь знаниями: расскажите друзьям и близким о важности бережного отношения к природе.',
    ],
  },
];

export default function EcoPage() {
  return (
    <div className="ds-page min-h-screen">
      <Header />

      <main className="pb-20">
        {/* Hero */}
        <section className="max-w-3xl mx-auto px-4 pt-12 pb-10">
          <div className="flex items-center gap-2 text-[var(--success)] mb-4">
            <Leaf className="w-4 h-4" />
            <span className="text-xs font-medium uppercase tracking-wider">Экотуризм</span>
          </div>
          <h1 className="font-playfair font-bold text-4xl md:text-5xl text-[var(--text-primary)] leading-tight [text-wrap:balance]">
            Путешествуйте и сохраняйте природу
          </h1>
          <p className="mt-5 text-base md:text-lg text-[var(--text-secondary)] leading-relaxed max-w-2xl">
            Отправляясь в путешествие по Камчатке, помните: осознанный подход помогает
            сохранить её первозданную красоту. Следуйте этим принципам — и природа
            останется такой же удивительной для следующих поколений.
          </p>
        </section>

        {/* Принципы */}
        <section className="max-w-3xl mx-auto px-4 space-y-4">
          {PRINCIPLES.map((p, i) => (
            <article key={i} className="ds-card px-5 py-5 md:px-6">
              <div className="flex items-start gap-4">
                <div className="shrink-0 p-2.5 rounded-lg bg-[var(--success)]/12 text-[var(--success)]">
                  {p.icon}
                </div>
                <div className="min-w-0">
                  <h2 className="font-playfair font-bold text-xl text-[var(--text-primary)] leading-snug">
                    <span className="text-[var(--text-muted)] mr-2">{i + 1}.</span>
                    {p.title}
                  </h2>
                  <ul className="mt-3 space-y-2 list-disc pl-5 marker:text-[var(--success)]">
                    {p.points.map((point, j) => (
                      <li key={j} className="text-sm text-[var(--text-secondary)] leading-relaxed">
                        {point}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </article>
          ))}
        </section>

        {/* Завершение */}
        <section className="max-w-3xl mx-auto px-4 mt-10">
          <p className="text-xs text-[var(--text-muted)] leading-relaxed border-t border-[var(--border)] pt-5">
            Камчатка — объект Всемирного природного наследия ЮНЕСКО. Её экосистемы
            складывались миллионы лет — наш визит должен оставлять след только в памяти.
            Эти принципы действуют на всех маршрутах платформы; на особо охраняемых
            территориях дополнительно действуют правила конкретной территории.
          </p>
        </section>
      </main>
    </div>
  );
}
