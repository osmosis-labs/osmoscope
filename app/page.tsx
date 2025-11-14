import { OsmosisDashboard } from "@/components/OsmosisDashboard";

export default function Home() {
  return (
    <main className="min-h-screen bg-gradient-to-br from-osmo-900 via-osmo-800 to-osmo-900 p-4 sm:p-8">
      <div className="mx-auto max-w-7xl">
        <header className="mb-8 mt-2 flex items-center justify-center gap-4">
          <img
            src="/Osmosis_Icon.png"
            alt="Osmosis Logo"
            className="h-16 w-16 sm:h-20 sm:w-20"
          />
          <h1 className="text-4xl font-bold text-white sm:text-5xl">
            OSMO Tokenomics Dashboard
          </h1>
        </header>

        <OsmosisDashboard />
      </div>
    </main>
  );
}
