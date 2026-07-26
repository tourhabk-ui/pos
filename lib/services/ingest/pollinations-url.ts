/**
 * Pollinations.ai URL-строитель (бесплатный Flux, без ключа). Вынесен в
 * leaf-модуль, чтобы cover-image.ts и ai-image-generator.ts могли им
 * пользоваться без взаимного импорта (иначе — цикл).
 */
export function buildPollinationsUrl(
  prompt: string,
  seed: number,
  width = 1280,
  height = 720,
): string {
  const encodedPrompt = encodeURIComponent(prompt);
  return `https://image.pollinations.ai/prompt/${encodedPrompt}?width=${width}&height=${height}&seed=${seed}&model=flux&nologo=true`;
}
