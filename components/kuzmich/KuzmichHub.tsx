'use client';

import React from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { Flame, Snowflake, Waves, Droplets, Bird, AlertCircle, CloudSun, Map, Navigation, ArrowRight } from 'lucide-react';

const TOOLS = [
  {
    icon: CloudSun,
    title: 'Погода',
    desc: '7-дневный прогноз',
    href: '/safety',
  },
  {
    icon: Flame,
    title: 'Вулканы',
    desc: 'Статус KVERT',
    href: '/safety',
  },
  {
    icon: Map,
    title: 'Маршруты',
    desc: 'Места и треки',
    href: '/routes',
  },
  {
    icon: Navigation,
    title: 'Планировщик',
    desc: 'AI-маршрут под вас',
    href: '/ai-assistant',
  },
];

interface ElementCard {
  id: string;
  number: string;
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  href: string;
  bgImage: string;
}

const ELEMENTS: ElementCard[] = [
  {
    id: 'fire',
    number: '01',
    title: 'ОГОНЬ',
    subtitle: 'Вулканы и мощь земли',
    icon: <Flame size={24} />,
    href: '/routes?location_type=volcano',
    bgImage: '/images/bento/mutnovsky.jpg'
  },
  {
    id: 'ice',
    number: '02',
    title: 'ЛЕД И СНЕГ',
    subtitle: 'Зимний спорт и хели-ски',
    icon: <Snowflake size={24} />,
    href: '/routes?category=snegohod',
    bgImage: '/images/bento/paratunka.jpg'
  },
  {
    id: 'water',
    number: '03',
    title: 'ВОДА',
    subtitle: 'Океан, реки и серфинг',
    icon: <Waves size={24} />,
    href: '/routes?category=morskie_progulki',
    bgImage: '/images/bento/khalaktyr.jpg'
  },
  {
    id: 'thermal',
    number: '04',
    title: 'ТЕРМЫ',
    subtitle: 'Горячие источники и релакс',
    icon: <Droplets size={24} />,
    href: '/routes?location_type=hot_spring',
    bgImage: '/images/bento/laguna.jpg'
  },
  {
    id: 'wildlife',
    number: '05',
    title: 'ДИКАЯ ПРИРОДА',
    subtitle: 'Медведи, орлы и не только',
    icon: <Bird size={24} />,
    href: '/routes?category=medvedi',
    bgImage: '/images/bento/cape.jpg'
  },
  {
    id: 'safety',
    number: '06',
    title: 'БЕЗОПАСНОСТЬ',
    subtitle: 'Будьте в курсе ситуации',
    icon: <AlertCircle size={24} />,
    href: '/safety',
    bgImage: '/images/hero/hero-light.jpeg'
  },
];

export function KuzmichHub() {
  const router = useRouter();

  return (
    <div className="min-h-screen bg-[var(--bg-primary)] pb-32">
      {/* Editorial Header */}
      <div className="relative h-[60vh] flex items-center justify-center overflow-hidden bg-[var(--bg-primary)]">
        <div className="absolute inset-0 opacity-50">
          <Image 
            src="/images/hero/IMG_20260316_133049.jpg" 
            alt="Kuzmich Hub Hero"
            fill
            className="object-cover"
          />
        </div>
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-[var(--bg-primary)]" />
        
        <div className="relative z-10 text-center px-6">
          <span className="text-[var(--accent)] font-bold tracking-[0.5em] uppercase text-[10px] mb-4 inline-block">
            Digital Navigator • Kuzmich Hub
          </span>
          <h1 className="font-playfair text-6xl md:text-8xl text-[var(--text-primary)] font-bold mb-6">
            Кузьмич <br /> <span className="italic text-[var(--accent)]">Хаб</span>
          </h1>
          <p className="text-[var(--text-secondary)] text-lg md:text-xl max-w-2xl mx-auto font-light leading-relaxed">
            Ваша точка входа в экосистему Камчатки. Выберите стихию для начала исследования или обратитесь к AI-ассистенту за советом.
          </p>
        </div>
      </div>

      {/* Kuzmich Intro + Travel Tools */}
      <div className="container mx-auto px-6 -mt-10 relative z-20 mb-12">
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-6 md:p-8 mb-8">
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-6 mb-8">
            <div className="relative w-16 h-16 rounded-full overflow-hidden flex-shrink-0 border-2 border-[var(--accent)]">
              <Image
                src="/images/hero/bears-kurilskoye.jpg"
                alt="Кузьмич"
                fill
                className="object-cover"
              />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[var(--text-muted)] text-[10px] uppercase tracking-[0.3em] font-bold mb-1">
                Кузьмич говорит
              </p>
              <p className="font-playfair text-lg md:text-xl italic text-[var(--text-primary)] leading-snug">
                «Привет! Помогу спланировать маршрут по Камчатке — расскажи что интересует.»
              </p>
            </div>
            <Link
              href="/ai-assistant"
              className="ds-btn ds-btn-primary flex-shrink-0 flex items-center gap-2"
            >
              Спросить <ArrowRight size={16} />
            </Link>
          </div>

          <p className="text-[var(--text-muted)] text-[10px] uppercase tracking-[0.3em] font-bold mb-4">
            Инструменты путешественника
          </p>
          <div className="grid grid-cols-2 gap-3">
            {TOOLS.map((tool) => {
              const Icon = tool.icon;
              return (
                <Link
                  key={tool.title}
                  href={tool.href}
                  className="group flex items-center gap-3 p-4 rounded-lg bg-[var(--bg-hover)] border border-[var(--border)] hover:border-[var(--accent)]/40 transition-colors"
                >
                  <div className="w-9 h-9 rounded-lg bg-[var(--accent)]/10 flex items-center justify-center flex-shrink-0 group-hover:bg-[var(--accent)]/20 transition-colors">
                    <Icon size={18} className="text-[var(--accent)]" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-[var(--text-primary)] leading-tight">{tool.title}</p>
                    <p className="text-xs text-[var(--text-muted)]">{tool.desc}</p>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      </div>

      {/* Grid Section */}
      <div className="container mx-auto px-6 relative z-20">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {ELEMENTS.map((el) => (
            <Link key={el.id} href={el.href} className="group relative h-[300px] overflow-hidden rounded-lg bg-[var(--bg-card)] border border-[var(--border)]">
              <div className="absolute inset-0 bg-[var(--bg-primary)]/40 group-hover:bg-[var(--bg-primary)]/60 transition-colors duration-500 z-10" />
              <Image 
                src={el.bgImage} 
                alt={el.title}
                fill
                className="object-cover opacity-60 transition-transform duration-700 group-hover:scale-110" 
              />
              
              <div className="relative z-20 p-8 h-full flex flex-col justify-between">
                <div className="flex justify-between items-start">
                  <span className="text-[var(--text-muted)] font-playfair italic text-3xl font-bold">{el.number}</span>
                  <div className="text-[var(--accent)] p-2 rounded-full bg-[var(--bg-card)] border border-[var(--border)]">
                    {el.icon}
                  </div>
                </div>
                
                <div>
                  <h3 className="font-playfair text-2xl text-[var(--text-primary)] font-bold mb-2 uppercase tracking-wider">{el.title}</h3>
                  <p className="text-[var(--text-muted)] text-sm font-light mb-4">{el.subtitle}</p>
                  <div className="w-8 h-px bg-[var(--accent)] transition-all duration-500 group-hover:w-full" />
                </div>
              </div>
            </Link>
          ))}
        </div>
      </div>

      {/* Call to Action */}
      <div className="container mx-auto px-6 mt-24 text-center">
        <div className="max-w-3xl mx-auto p-12 border border-[var(--border)] rounded-lg bg-[var(--bg-card)]">
          <h2 className="font-playfair text-4xl font-bold mb-6 text-[var(--text-primary)]">Нужна помощь в планировании?</h2>
          <p className="text-[var(--text-secondary)] mb-10 text-lg font-light">
            Наш AI-проводник Кузьмич проанализирует погоду, активность вулканов и ваши предпочтения, чтобы составить идеальный маршрут.
          </p>
          <button 
            onClick={() => router.push('/ai-assistant')}
            className="ds-btn ds-btn-primary px-10 py-4"
          >
            Запустить чат с Кузьмичом
          </button>
        </div>
      </div>
    </div>
  );
}
