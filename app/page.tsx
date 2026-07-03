import { OsmosisDashboard } from "@/components/OsmosisDashboard";
import { SiteHeader } from "@/components/SiteHeader";

export default function Home() {
  return (
    <main className="min-h-screen bg-gradient-to-br from-osmo-900 via-osmo-800 to-osmo-900 p-4 sm:p-8">
      <div className="mx-auto max-w-7xl">
        <SiteHeader subtitle="Tokenomics" current="/" />
        <OsmosisDashboard />
      </div>
    </main>
  );
}
