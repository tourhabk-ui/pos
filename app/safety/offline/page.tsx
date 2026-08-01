import type { Metadata } from 'next';
import { Shield, AlertTriangle, Phone, MapPin, Thermometer, Wind, Navigation, Eye, Clock, CheckCircle } from 'lucide-react';
import { Header } from '@/components/layout/Header';
import { EMERGENCY_NUMBERS } from '@/lib/safety/emergency-numbers';

export const metadata: Metadata = {
  title: 'Выживание на Камчатке — офлайн-инструкции',
  description: 'Экстренные инструкции для туристов на Камчатке. Медведи, вулканы, гипотермия, потерялся в тайге. Работает без интернета.',
};

// Полностью статическая страница — нет fetch, нет DB.
// Добавлена в PRECACHE_URLS → доступна офлайн сразу после установки PWA.

const SECTIONS = [
  {
    id: 'bear',
    icon: Eye,
    color: 'var(--danger)',
    title: 'Встреча с медведем',
    urgent: 'Никогда не беги — инстинкт преследования сработает мгновенно',
    // Тактика при нападении выправлена 01.08.2026 по разбору экспертов проекта
    // «Земля медведя» (Фонд защитников природы; охотовед Кроноцкого заповедника):
    // «бей в нос и глаза, не ложись» — миф из доктрины чёрных медведей, которых на
    // Камчатке нет. Для бурого при неизбежном контакте — сгруппироваться, защитить
    // голову/шею/живот и НЕ сопротивляться; активная драка уместна только против
    // явного хищнического нападения (крайне редкий случай — шатун).
    steps: [
      'Не заметил тебя — тихо уйди по большой дуге, не привлекая внимания.',
      'Заметил — остановись. Говори спокойным низким голосом: дай понять, что ты человек.',
      'Выгляди крупнее: подними руки или рюкзак над головой. Держи антизверь наготове.',
      'Медленно отступай боком, не поворачивайся спиной.',
      'Признаки агрессии: мотание головой, фырканье, слюнотечение, ложные выпады. Встал на задние лапы — любопытство, не атака.',
      'Сближается — распыляй антизверь навстречу. Контакта не избежать: сгруппируйся, защити голову, шею и живот, не сопротивляйся.',
      'Медвежата — рядом медведица: уходи немедленно, не приближайся и не фотографируй.',
    ],
  },
  {
    id: 'volcano',
    icon: Wind,
    color: 'var(--accent)',
    title: 'Вулканическая опасность',
    urgent: 'Запах серы + тремор земли = уходи немедленно, не жди',
    steps: [
      'Признаки активизации: запах серы, подземный гул, мелкий тремор, гибель птиц.',
      'Пепловое облако: закрой рот и нос любой тканью, двигайся перпендикулярно ветру.',
      'Лавовый поток медленный — уходи вверх по склону и в сторону от потока.',
      'Пирокластический поток (раскалённый газ) — спасения нет, не допускай такой ситуации.',
      'Сильный пепел: не снимай одежду, пепел режет лёгкие. Укрыться в здании, заткнуть щели.',
      'Термальные поля: никогда не ступай на белую/жёлтую землю — корка тонкая, под ней кипяток.',
    ],
  },
  {
    id: 'hypothermia',
    icon: Thermometer,
    color: 'var(--ocean)',
    title: 'Гипотермия',
    urgent: 'Дрожь прекратилась, человек вялый и хочет спать — критическая стадия',
    steps: [
      'Лёгкая (дрожь, бледность): убери от ветра, сними мокрое, укутай в спальник + поделись теплом тела.',
      'Средняя (нет дрожи, спутанность): горизонтально, не двигай — может остановить сердце.',
      'Тёплое питьё только если человек в сознании и глотает сам. Алкоголь запрещён.',
      'Отогревай тело (грудь, подмышки, пах), не конечности — кровь с холодной периферии убивает.',
      'Мокрая одежда забирает тепло в 25× быстрее сухой. Приоритет — сухость.',
      'Звони 112. Передай координаты. Не оставляй человека одного.',
    ],
  },
  {
    id: 'lost',
    icon: Navigation,
    color: 'var(--success)',
    title: 'Потерялся в тайге',
    urgent: 'СТОП — стой где стоишь, не паникуй, сигнализируй',
    steps: [
      'S.T.O.P.: Stop (стой), Think (думай), Observe (осмотрись), Plan (план).',
      'Не иди наугад — каждый шаг удаляет тебя от зоны поиска.',
      'Признаки реки: иди вниз по склону — выведет к воде, затем к людям.',
      'Костёр: три костра треугольником — международный сигнал бедствия.',
      'Ночлег: лапник на земле 15 см — утеплитель от холода снизу важнее укрытия сверху.',
      'Береги заряд телефона: авиарежим + геолокацию включай только для звонка.',
      'Сообщи координаты в МЧС: широта __ градусов __ минут, долгота __ градусов __ минут.',
    ],
  },
  {
    id: 'signal',
    icon: AlertTriangle,
    color: 'var(--warning)',
    title: 'Сигнализация спасателям',
    urgent: '3 сигнала с паузой — международный знак бедствия',
    steps: [
      'Три костра треугольником (50 м между кострами) — видны с вертолёта.',
      'Зеркало / фольга / телефонный экран: отражай солнце на вертолёт — луч виден на 10+ км.',
      'Три свистка с паузой, три крика, три выстрела — повторяй каждые 10 минут.',
      'Открытое место: выйди на поляну, выложи знак SOS из камней/ветвей (5+ метров высотой буквы).',
      'Яркая одежда: разложи на камнях или снегу — заметна с воздуха.',
      'При звуке вертолёта: разожги костёр с дымом (сырые ветки, листья, резина).',
    ],
  },
  {
    id: 'water',
    icon: MapPin,
    color: 'var(--success)',
    title: 'Вода и еда',
    urgent: 'Без воды — 3 дня. Без еды — 3 недели. Вода — приоритет',
    steps: [
      'Горные ручьи выше населённых пунктов и термальных источников — можно пить.',
      'Термальные источники: вода может содержать мышьяк и сероводород — не пить.',
      'Кипячение 1 минута убивает всё биологическое. Химию не убивает.',
      'Роса: утром собирай тканью с растений — 0.5 л/час при хорошей росе.',
      'Ягоды Камчатки: жимолость (синяя), шикша (чёрная), голубика — съедобны. Красные незнакомые — не трогай.',
      'Рыба в реках: голыми руками не поймать, нужна снасть или острога из ветки.',
    ],
  },
];

export default function OfflineSurvivalPage() {
  return (
    <div className="bg-[var(--bg-primary)] text-[var(--text-primary)] min-h-[100dvh]">
      <Header />

      <main className="pt-16 pb-24">
        {/* Hero */}
        <section className="ds-section border-b border-[var(--border)]">
          <div className="flex items-start gap-4 max-w-3xl">
            <div className="p-3 rounded-xl flex-shrink-0" style={{ background: 'color-mix(in srgb, var(--danger) 12%, transparent)' }}>
              <Shield className="w-7 h-7" style={{ color: 'var(--danger)' }} />
            </div>
            <div>
              <p className="text-xs uppercase tracking-widest text-[var(--text-muted)] mb-2">Офлайн-инструкции</p>
              <h1 className="font-playfair text-3xl font-bold mb-3">Выживание на Камчатке</h1>
              <p className="text-[var(--text-secondary)] leading-relaxed">
                Эта страница работает без интернета. Прочитай до выхода на маршрут.
                В экстренной ситуации действуй по инструкции — не импровизируй.
              </p>
            </div>
          </div>
        </section>

        {/* ── Инструкция по приложению ──────────────────────────────────── */}
        <section className="ds-section border-b border-[var(--border)]">
          <div className="max-w-2xl space-y-5">

            {/* Перед выходом */}
            <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border)', background: 'var(--bg-card)' }}>
              <div className="flex items-center gap-3 px-5 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
                <CheckCircle className="w-5 h-5 flex-shrink-0" style={{ color: 'var(--success)' }} />
                <h2 className="font-semibold text-[var(--text-primary)]">Перед выходом на маршрут</h2>
              </div>
              <ol className="px-5 py-4 space-y-3">
                {[
                  'Зарегистрируй маршрут на /register. Укажи название, даты, контрольное время возврата и экстренный контакт. Регистрация даёт спасателям точку отсчёта — не гарантирует спасение, но ускоряет поиск.',
                  'Скачай карту офлайн на /offline/manage. Камчатка — зона нестабильной связи. Карта и GPS-чип работают без интернета.',
                  'Убедись что экстренный контакт — реальный человек, который поднимет тревогу если ты не вышел на связь.',
                ].map((text, i) => (
                  <li key={i} className="flex gap-3 text-sm">
                    <span className="flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold mt-0.5"
                      style={{ background: 'color-mix(in srgb, var(--success) 15%, transparent)', color: 'var(--success)' }}>
                      {i + 1}
                    </span>
                    <span className="text-[var(--text-secondary)] leading-relaxed">{text}</span>
                  </li>
                ))}
              </ol>
            </div>

            {/* На маршруте */}
            <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border)', background: 'var(--bg-card)' }}>
              <div className="flex items-center gap-3 px-5 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
                <Clock className="w-5 h-5 flex-shrink-0" style={{ color: 'var(--ocean)' }} />
                <h2 className="font-semibold text-[var(--text-primary)]">На маршруте</h2>
              </div>
              <div className="px-5 py-4 space-y-3 text-sm text-[var(--text-secondary)] leading-relaxed">
                <p>
                  Приложение автоматически следит за возвратом по контрольному времени.
                  При просрочке срабатывает лестница эскалации:
                </p>
                <div className="rounded-lg overflow-hidden border" style={{ borderColor: 'var(--border)' }}>
                  <table className="w-full text-xs">
                    <thead>
                      <tr style={{ background: 'var(--bg-hover)' }}>
                        <th className="text-left px-3 py-2 text-[var(--text-muted)] font-medium">Просрочка</th>
                        <th className="text-left px-3 py-2 text-[var(--text-muted)] font-medium">Однодневный</th>
                        <th className="text-left px-3 py-2 text-[var(--text-muted)] font-medium">Многодневный</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[
                        ['Напоминание (soft)', '1 ч', '3 ч'],
                        ['Тревога экстренному контакту', '3 ч', '6 ч'],
                        ['Передача в МЧС', '8 ч', '18 ч'],
                      ].map(([label, day, multi]) => (
                        <tr key={label} className="border-t" style={{ borderColor: 'var(--border)' }}>
                          <td className="px-3 py-2 text-[var(--text-secondary)]">{label}</td>
                          <td className="px-3 py-2 font-medium text-[var(--text-primary)]">{day}</td>
                          <td className="px-3 py-2 font-medium text-[var(--text-primary)]">{multi}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p>
                  Вернулся раньше — нажми «Я вернулся» на /return или на карте. Это останавливает эскалацию.
                </p>
                <p>
                  Геофенсинг предупредит, если ты приближаешься к зоне вулканической активности,
                  термальных источников или гейзеров. Работает без интернета (зоны загружены заранее).
                </p>
              </div>
            </div>

            {/* Экстренная ситуация — 4 шага */}
            <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border)', background: 'var(--bg-card)' }}>
              <div className="flex items-center gap-3 px-5 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
                <AlertTriangle className="w-5 h-5 flex-shrink-0" style={{ color: 'var(--danger)' }} />
                <h2 className="font-semibold text-[var(--text-primary)]">Экстренная ситуация — 4 шага</h2>
              </div>
              <ol className="px-5 py-4 space-y-3">
                {[
                  { text: 'Открой /sos и нажми кнопку «Отправить координаты» — координаты уйдут в систему и экстренным контактам.', color: 'var(--danger)' },
                  { text: 'Позвони 112. Назови координаты — они на экране SOS. Работает без интернета, нужен сотовый сигнал.', color: 'var(--danger)' },
                  { text: 'Нет голосового сигнала — отправь SMS кнопкой «Без интернета» на экране SOS. SMS проходит там, где голос нет.', color: 'var(--warning)' },
                  { text: 'Стой на месте. Если зарегистрировал маршрут — спасатели знают твой маршрут. Хаотичное движение усложняет поиск.', color: 'var(--warning)' },
                ].map(({ text, color }, i) => (
                  <li key={i} className="flex gap-3 text-sm">
                    <span className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold mt-0.5"
                      style={{ background: `color-mix(in srgb, ${color} 15%, transparent)`, color }}>
                      {i + 1}
                    </span>
                    <span className="text-[var(--text-secondary)] leading-relaxed">{text}</span>
                  </li>
                ))}
              </ol>
            </div>

            {/* Что система НЕ умеет — самая важная секция, визуально выделена */}
            <div className="rounded-xl border-2 overflow-hidden" style={{ borderColor: 'var(--warning)' }}>
              <div className="flex items-center gap-3 px-5 py-4 border-b" style={{ borderColor: 'var(--warning)', background: 'color-mix(in srgb, var(--warning) 8%, transparent)' }}>
                <AlertTriangle className="w-5 h-5 flex-shrink-0" style={{ color: 'var(--warning)' }} />
                <h2 className="font-semibold" style={{ color: 'var(--warning)' }}>Честно: что система не умеет</h2>
              </div>
              <ul className="px-5 py-4 space-y-3" style={{ background: 'color-mix(in srgb, var(--warning) 4%, transparent)' }}>
                {[
                  'Не заменяет спутниковый коммуникатор. Garmin inReach или SPOT работают без сотовой сети — приложение нет.',
                  'SMS и SOS-сигнал уйдут только при наличии сотового сигнала. В горах покрытие фрагментарное.',
                  'Геофенсинг — инструмент, не страховка. Радиусы опасных зон — инженерные оценки, не данные KVERT. При активном извержении опасная зона шире.',
                  'Регистрация маршрута даёт спасателям точку отсчёта, не гарантирует спасение.',
                  'Офлайн-карта не заменяет бумажную. Телефон разряжается — возьми распечатку для длинных маршрутов.',
                ].map((text, i) => (
                  <li key={i} className="flex gap-3 text-sm">
                    <span className="flex-shrink-0 mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: 'var(--warning)' }} />
                    <span className="text-[var(--text-secondary)] leading-relaxed">{text}</span>
                  </li>
                ))}
              </ul>
            </div>

          </div>
        </section>

        {/* Экстренные контакты — первыми, на видном месте */}
        <section className="ds-section border-b border-[var(--border)]">
          <div className="max-w-2xl">
            <p className="text-xs uppercase tracking-widest text-[var(--text-muted)] mb-4">Экстренные контакты</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Единый источник номеров (см. lib/safety/emergency-numbers.ts). */}
              {EMERGENCY_NUMBERS.map((c) => ({ label: c.name, number: c.phone, note: c.hint ?? c.type })).map(({ label, number, note }) => (
                <a
                  key={number + label}
                  href={`tel:${number.replace(/\D/g, '')}`}
                  className="flex items-center gap-3 p-4 rounded-xl border transition-all hover:shadow-sm active:scale-95"
                  style={{ background: 'var(--bg-card)', borderColor: 'var(--border)' }}
                >
                  <div className="p-2 rounded-lg flex-shrink-0" style={{ background: 'color-mix(in srgb, var(--danger) 12%, transparent)' }}>
                    <Phone className="w-4 h-4" style={{ color: 'var(--danger)' }} />
                  </div>
                  <div>
                    <p className="text-xs text-[var(--text-muted)]">{label}</p>
                    <p className="font-bold text-[var(--text-primary)] text-lg leading-tight">{number}</p>
                    <p className="text-xs text-[var(--text-secondary)]">{note}</p>
                  </div>
                </a>
              ))}
            </div>
          </div>
        </section>

        {/* Инструкции */}
        <section className="ds-section">
          <div className="max-w-2xl space-y-6">
            {SECTIONS.map((section) => {
              const Icon = section.icon;
              return (
                <div
                  key={section.id}
                  className="rounded-xl border overflow-hidden"
                  style={{ borderColor: 'var(--border)', background: 'var(--bg-card)' }}
                >
                  {/* Заголовок */}
                  <div className="flex items-center gap-3 px-5 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
                    <div className="p-2 rounded-lg flex-shrink-0" style={{ background: `color-mix(in srgb, ${section.color} 12%, transparent)` }}>
                      <Icon className="w-4 h-4" style={{ color: section.color }} />
                    </div>
                    <div>
                      <h2 className="font-semibold text-[var(--text-primary)]">{section.title}</h2>
                    </div>
                  </div>

                  {/* Urgent */}
                  <div className="px-5 py-3 border-b" style={{ borderColor: 'var(--border)', background: `color-mix(in srgb, ${section.color} 6%, transparent)` }}>
                    <p className="text-sm font-medium" style={{ color: section.color }}>{section.urgent}</p>
                  </div>

                  {/* Шаги */}
                  <ol className="px-5 py-4 space-y-3">
                    {section.steps.map((step, i) => (
                      <li key={i} className="flex gap-3 text-sm">
                        <span className="flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold mt-0.5"
                          style={{ background: `color-mix(in srgb, ${section.color} 15%, transparent)`, color: section.color }}>
                          {i + 1}
                        </span>
                        <span className="text-[var(--text-secondary)] leading-relaxed">{step}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              );
            })}
          </div>
        </section>

        {/* Footer note */}
        <section className="ds-section">
          <div className="max-w-2xl p-4 rounded-xl border" style={{ borderColor: 'var(--border)', background: 'var(--bg-card)' }}>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed">
              Эта страница сохранена на твоём устройстве и работает без интернета.
              Перед каждым выходом на маршрут сообщи кому-то маршрут и дату возвращения.
              Зарегистрируй группу в МЧС на маршрутах с обязательной регистрацией.
            </p>
          </div>
        </section>
      </main>
    </div>
  );
}
