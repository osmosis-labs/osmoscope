import { useQuery } from "@tanstack/react-query";

// Symbol -> logo URI map (from the assetlist via /api/asset-logos). Logos are
// effectively static, so one fetch per session is plenty.
export function useAssetLogos() {
  return useQuery({
    queryKey: ["asset-logos"],
    queryFn: async (): Promise<{ logos: Record<string, string> }> => {
      const response = await fetch("/api/asset-logos");
      if (!response.ok) throw new Error("Failed to fetch asset logos");
      return response.json();
    },
    staleTime: 60 * 60_000,
    refetchOnWindowFocus: false,
  });
}
