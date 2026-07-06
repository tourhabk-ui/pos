import React from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { Heart, MapPin } from 'lucide-react';

export function TravelerCard() {
  return (
    <div className="mx-4 mb-2 relative rounded-lg overflow-hidden h-[220px]">
      <Image
        src="/images/hero/hero-light.jpeg"
        alt="История путешественника"
        fill
        className="object-cover"
      />
      <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/30 to-transparent" />

      <div className="absolute inset-0 flex flex-col justify-between p-5">
        {/* Author */}
        <div className="flex items-center gap-2">
          <div className="relative w-9 h-9 rounded-full overflow-hidden ring-2 ring-white/30 flex-shrink-0">
            <Image src="/images/hero/bears-kurilskoye.jpg" alt="" fill className="object-cover" />
          </div>
          <div>
            <p className="text-white text-xs font-semibold leading-none">Мария, 26 лет</p>
            <p className="text-white/60 text-[10px]">3 дня назад</p>
          </div>
        </div>

        {/* Quote */}
        <div>
          <p className="text-white font-playfair italic text-base leading-snug mb-3">
            &ldquo;Когда облака разошлись, я увидела всю Камчатку...&rdquo;
          </p>
          <div className="flex items-center justify-between">
            <Link href="/routes?location_type=volcano" className="inline-flex items-center gap-1 text-[10px] text-white/70">
              <MapPin size={10} />
              Авачинский вулкан · 2 дня
            </Link>
            <div className="flex items-center gap-1 text-white/70 text-xs">
              <Heart size={12} className="text-[var(--accent)]" />
              47
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
