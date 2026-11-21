/**
 * Кадры посадочной (lib/landings/design): главный кадр с H1 и крошками и
 * фото в тексте. Серверные, без гидратации. Главный кадр — LCP: preload,
 * fetchPriority=high, без lazy, высота рамки задана CSS заранее (CLS 0).
 * Кадр в тексте — lazy, рамка 16:9 зарезервирована. Подпись автора всегда.
 */
import Link from 'next/link';
import { preload } from 'react-dom';
import { photoSrc, photoSrcSet } from '@/lib/images/variant';
import type { LandingFigure, LandingPhoto, LandingPhotoCredit } from '@/lib/landings/design';

export function LandingCredit({ credit }: { credit: LandingPhotoCredit }) {
  return credit.href
    ? <Link href={credit.href} className="underline decoration-dotted underline-offset-2" data-photo-credit="operator">{credit.name}</Link>
    : <span data-photo-credit="owner">{credit.name}</span>;
}

function Caption({ photo, className }: { photo: LandingPhoto; className: string }) {
  return (
    <figcaption className={className}>
      {photo.caption} Фото: <LandingCredit credit={photo.credit} />
    </figcaption>
  );
}

export function LandingHero({ h1, photo }: { h1: string; photo: LandingPhoto | null }) {
  const src = photo ? photoSrc(photo.src, 1280) : '';
  const srcSet = photo ? photoSrcSet(photo.src) : undefined;
  if (photo) {
    preload(src, { as: 'image', fetchPriority: 'high', ...(srcSet ? { imageSrcSet: srcSet, imageSizes: '100vw' } : {}) });
  }
  return (
    <figure className={photo ? 'landing-hero' : 'landing-hero landing-hero--plain'} data-landing-hero={photo ? 'photo' : 'plain'}>
      {photo && (
        <img
          src={src}
          srcSet={srcSet}
          sizes={srcSet ? '100vw' : undefined}
          alt={photo.alt}
          width={photo.width}
          height={photo.height}
          fetchPriority="high"
          decoding="async"
          style={photo.focus ? { objectPosition: photo.focus } : undefined}
        />
      )}
      {photo && <div className="landing-hero-scrim" aria-hidden="true" />}
      <div className="landing-hero-inner">
        <nav className="landing-crumbs" aria-label="Хлебные крошки">
          <Link href="/">Главная</Link>
          <span aria-hidden="true"> · </span>
          <span aria-current="page">{h1}</span>
        </nav>
        <h1 className="landing-h1">{h1}</h1>
        {photo && <Caption photo={photo} className="landing-hero-cap" />}
      </div>
    </figure>
  );
}

export function LandingFigureView({ figure }: { figure: LandingFigure }) {
  return (
    <figure className="landing-figure" data-landing-figure="">
      <img
        src={photoSrc(figure.src, 640)}
        srcSet={photoSrcSet(figure.src)}
        sizes="(max-width: 768px) 100vw, 48rem"
        alt={figure.alt}
        width={figure.width}
        height={figure.height}
        loading="lazy"
        decoding="async"
        style={figure.focus ? { objectPosition: figure.focus } : undefined}
      />
      <Caption photo={figure} className="landing-figure-cap" />
    </figure>
  );
}
