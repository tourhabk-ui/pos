import type { Metadata } from 'next';
import { Header } from '@/components/layout/Header';
import {
  Satellite, MessagesSquare, RadioTower, Smartphone,
  ShieldAlert, ClipboardCheck, MapPinned,
} from 'lucide-react';

export const metadata: Metadata = {
  title: 'Связь и навигация на маршрутах Камчатки',
  description:
    'Как передать координаты там, где нет сотовой связи: спутниковые маяки PLB, Garmin inReach, камчатская система «Вензор», рации. Честный рейтинг надёжности и регистрация в МЧС.',
  keywords: [
    'связь на Камчатке',
    'спутниковый маяк PLB',
    'Garmin inReach Камчатка',
    'Вензор Камчатка',
    'регистрация МЧС туристы',
    'связь в походе без сотовой сети',
  ],
  openGraph: {
    title: 'Связь и навигация на маршрутах Камчатки',
    description:
      'На большинстве маршрутов Камчатки сотовой связи нет. Разбор способов передать координаты: PLB, inReach, «Вензор», рации — и честный рейтинг надёжности.',
    url: 'https://vedarai.ru/safety/communication',
    siteName: 'Ведар',
    locale: 'ru_RU',
    type: 'article',
  },
  alternates: { canonical: 'https://vedarai.ru/safety/communication' },
};

interface Device {
  icon: React.ReactNode;
  name: string;
  channel: string;
  twoWay: string;
  cost: string;
  bestFor: string;
  limits: string;
}

const DEVICES: Device[] = [
  {
    icon: <Satellite className="w-5 h-5" />,
    name: 'PLB — персональный радиомаяк (COSPAS-SARSAT)',
    channel: 'Односторонний сигнал бедствия через спутники, принимают государственные спасательные службы. Россия — участник системы.',
    twoWay: 'Нет: только «мне нужна помощь» с координатами. Сообщения не передаёт, экрана нет.',
    cost: 'Только покупка устройства, подписки нет. Маяк нужно зарегистрировать.',
    bestFor: 'Максимальная надёжность сигнала бедствия в любой точке мира.',
    limits: 'Не заменяет связь: спасатели получают сигнал, но переписки с ними нет.',
  },
  {
    icon: <MessagesSquare className="w-5 h-5" />,
    name: 'Спутниковый коммуникатор (Garmin inReach, Iridium)',
    channel: 'Двусторонняя спутниковая связь: SOS + текстовые сообщения + трекинг.',
    twoWay: 'Да: можно описать ситуацию и получить ответ спасателей.',
    cost: 'Устройство + платная подписка.',
    bestFor: 'Самый надёжный коммерческий вариант: связь и SOS в одном приборе.',
    limits: 'Дорого; требуется действующая подписка.',
  },
  {
    icon: <RadioTower className="w-5 h-5" />,
    name: '«Вензор» — камчатская LoRaWAN-система',
    channel: 'Носимый датчик с GPS/ГЛОНАСС передаёт координаты и короткие сообщения на наземные базовые станции.',
    twoWay: 'Ограниченно: короткие сообщения в зоне покрытия.',
    cost: 'Аренда — ориентировочно 150–200 ₽/день; уточняйте у оператора при аренде.',
    bestFor: 'Популярные маршруты Камчатки, где стоят базовые станции (район Авачинского, Козельского и другие).',
    limits: 'Работает ТОЛЬКО в зоне покрытия базовых станций. Карту покрытия мы пока не показываем: подтверждённых данных оператора у платформы нет — уточняйте зону при аренде.',
  },
  {
    icon: <Smartphone className="w-5 h-5" />,
    name: 'Смартфон + офлайн-карты + рация в группе',
    channel: 'GPS работает без сети — координаты и офлайн-карта доступны всегда. Рации VHF/UHF держат связь внутри группы.',
    twoWay: 'Внутри группы — да (рации). Наружу без сотового покрытия — нет.',
    cost: 'Почти бесплатно.',
    bestFor: 'Короткие выходы недалеко от покрытия; связь внутри группы.',
    limits: 'Передать сигнал бедствия без покрытия смартфон не может — это его честный предел.',
  },
];

const RATING = [
  'Спутниковый маяк PLB + регистрация группы в МЧС',
  'Garmin inReach / Iridium (двусторонняя связь + SOS)',
  'Датчик «Вензор» — в зоне покрытия базовых станций',
  'Смартфон с офлайн-картами + рация в группе',
  'Только смартфон без внешней связи — высокий риск',
];

export default function CommunicationPage() {
  return (
    <div className="ds-page min-h-screen">
      <Header />

      <main className="pb-20">
        {/* Hero */}
        <section className="max-w-3xl mx-auto px-4 pt-12 pb-10">
          <div className="flex items-center gap-2 text-[var(--ocean)] mb-4">
            <Satellite className="w-4 h-4" />
            <span className="text-xs font-medium uppercase tracking-wider">Безопасность</span>
          </div>
          <h1 className="font-playfair font-bold text-4xl md:text-5xl text-[var(--text-primary)] leading-tight [text-wrap:balance]">
            Связь и навигация там, где сети нет
          </h1>
          <p className="mt-5 text-base md:text-lg text-[var(--text-secondary)] leading-relaxed max-w-2xl">
            На большинстве маршрутов Камчатки сотовая связь отсутствует. GPS в телефоне
            продолжает работать — координаты и офлайн-карта у вас будут. Но передать
            сигнал бедствия наружу без специального устройства не получится. Разбираем
            варианты честно.
          </p>
        </section>

        {/* Рейтинг надёжности */}
        <section className="max-w-3xl mx-auto px-4">
          <div className="ds-card px-5 py-5 md:px-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2.5 rounded-lg bg-[var(--danger)]/10 text-[var(--danger)]">
                <ShieldAlert className="w-5 h-5" />
              </div>
              <h2 className="font-playfair font-bold text-xl text-[var(--text-primary)]">
                Рейтинг надёжности на Камчатке
              </h2>
            </div>
            <ol className="space-y-2">
              {RATING.map((r, i) => (
                <li key={i} className="flex items-start gap-3">
                  <span className="shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold bg-[var(--bg-hover)] text-[var(--text-secondary)]">
                    {i + 1}
                  </span>
                  <span className={`text-sm leading-relaxed ${i === RATING.length - 1 ? 'text-[var(--danger)] font-semibold' : 'text-[var(--text-secondary)]'}`}>
                    {r}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Устройства */}
        <section className="max-w-3xl mx-auto px-4 mt-6 space-y-4">
          {DEVICES.map((d, i) => (
            <article key={i} className="ds-card px-5 py-5 md:px-6">
              <div className="flex items-start gap-4">
                <div className="shrink-0 p-2.5 rounded-lg bg-[var(--ocean)]/12 text-[var(--ocean)]">
                  {d.icon}
                </div>
                <div className="min-w-0">
                  <h2 className="font-playfair font-bold text-lg text-[var(--text-primary)] leading-snug">
                    {d.name}
                  </h2>
                  <dl className="mt-3 space-y-2 text-sm leading-relaxed">
                    <div>
                      <dt className="inline font-semibold text-[var(--text-primary)]">Как работает: </dt>
                      <dd className="inline text-[var(--text-secondary)]">{d.channel}</dd>
                    </div>
                    <div>
                      <dt className="inline font-semibold text-[var(--text-primary)]">Двусторонняя связь: </dt>
                      <dd className="inline text-[var(--text-secondary)]">{d.twoWay}</dd>
                    </div>
                    <div>
                      <dt className="inline font-semibold text-[var(--text-primary)]">Стоимость: </dt>
                      <dd className="inline text-[var(--text-secondary)]">{d.cost}</dd>
                    </div>
                    <div>
                      <dt className="inline font-semibold text-[var(--text-primary)]">Лучше всего для: </dt>
                      <dd className="inline text-[var(--text-secondary)]">{d.bestFor}</dd>
                    </div>
                    <div>
                      <dt className="inline font-semibold text-[var(--text-primary)]">Ограничения: </dt>
                      <dd className="inline text-[var(--text-secondary)]">{d.limits}</dd>
                    </div>
                  </dl>
                </div>
              </div>
            </article>
          ))}
        </section>

        {/* МЧС + офлайн-подготовка */}
        <section className="max-w-3xl mx-auto px-4 mt-6 space-y-4">
          <div className="ds-card px-5 py-5 md:px-6">
            <div className="flex items-start gap-4">
              <div className="shrink-0 p-2.5 rounded-lg bg-[var(--accent)]/12 text-[var(--accent)]">
                <ClipboardCheck className="w-5 h-5" />
              </div>
              <div>
                <h2 className="font-playfair font-bold text-lg text-[var(--text-primary)]">
                  Регистрация группы в МЧС
                </h2>
                <p className="mt-2 text-sm text-[var(--text-secondary)] leading-relaxed">
                  Работает с любым устройством из списка и без устройств: спасатели знают
                  ваш маршрут и сроки — если группа не вышла на связь, поиск начнётся без
                  сигнала с вашей стороны. На многих маршрутах платформы регистрация
                  обязательна (отмечено на карточке маршрута).
                </p>
                <a
                  href="https://forms.mchs.gov.ru/registration_tourist_groups/form"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block mt-3 text-sm font-semibold text-[var(--ocean)] hover:underline"
                >
                  Онлайн-регистрация на сайте МЧС
                </a>
              </div>
            </div>
          </div>

          <div className="ds-card px-5 py-5 md:px-6">
            <div className="flex items-start gap-4">
              <div className="shrink-0 p-2.5 rounded-lg bg-[var(--success)]/12 text-[var(--success)]">
                <MapPinned className="w-5 h-5" />
              </div>
              <div>
                <h2 className="font-playfair font-bold text-lg text-[var(--text-primary)]">
                  Подготовьте телефон до выхода
                </h2>
                <p className="mt-2 text-sm text-[var(--text-secondary)] leading-relaxed">
                  Скачайте офлайн-карту района на странице карты — тайлы, маршруты и
                  экстренные телефоны сохранятся на телефоне. SOS-экран платформы работает
                  полностью без сети: координаты, QR для спасателя, SMS-шаблон.
                </p>
                <div className="mt-3 flex flex-wrap gap-4">
                  <a href="/map" className="text-sm font-semibold text-[var(--ocean)] hover:underline">
                    Скачать офлайн-карту
                  </a>
                  <a href="/emergency" className="text-sm font-semibold text-[var(--ocean)] hover:underline">
                    Офлайн-экран SOS
                  </a>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Честное завершение */}
        <section className="max-w-3xl mx-auto px-4 mt-10">
          <p className="text-xs text-[var(--text-muted)] leading-relaxed border-t border-[var(--border)] pt-5">
            Мы не продаём и не арендуем устройства связи и не получаем комиссию за их
            упоминание. Этот разбор — часть подготовки к маршруту: смартфон с офлайн-картой
            делает вас автономным в навигации, но сигнал бедствия наружу передаёт только
            спутниковый маяк, коммуникатор или датчик в зоне покрытия. Планируйте связь
            до выхода — на маршруте выбирать уже поздно.
          </p>
        </section>
      </main>
    </div>
  );
}
