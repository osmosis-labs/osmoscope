"use client";

import { useAssetLogos } from "@/lib/hooks/useAssetLogos";
import { cn } from "@/lib/utils";

// The asset's logo (from the assetlist, matched by display symbol), or nothing
// when the symbol has none — rows degrade to text-only, never a broken image.
// Purely decorative, so alt is empty and screen readers skip it.
export function AssetLogo({
  symbol,
  className,
}: {
  symbol: string;
  className?: string;
}) {
  const { data } = useAssetLogos();
  const uri = data?.logos[symbol];
  if (!uri) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- remote assetlist logos; next/image would need per-host config
    <img
      src={uri}
      alt=""
      loading="lazy"
      className={cn("h-4 w-4 shrink-0 rounded-full", className)}
    />
  );
}
