'use client';

import { useEffect, useRef } from 'react';
import type { AnimationItem } from 'lottie-web';

interface Props {
  src: string;
  width?: number;
  height?: number;
  loop?: boolean;
  autoplay?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

export default function LottiePlayer({
  src,
  width = 80,
  height = 80,
  loop = true,
  autoplay = true,
  className,
  style,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const animRef = useRef<AnimationItem | null>(null);

  useEffect(() => {
    let destroyed = false;

    import('lottie-web').then(({ default: lottie }) => {
      if (!containerRef.current || destroyed) return;
      animRef.current = lottie.loadAnimation({
        container: containerRef.current,
        renderer: 'svg',
        loop,
        autoplay,
        path: src,
      });
    });

    return () => {
      destroyed = true;
      animRef.current?.destroy();
      animRef.current = null;
    };
  }, [src, loop, autoplay]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ width, height, flexShrink: 0, ...style }}
    />
  );
}
