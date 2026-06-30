import { OsmosisDashboard } from "@/components/OsmosisDashboard";

export default function Home() {
  return (
    <main className="min-h-screen bg-gradient-to-br from-osmo-900 via-osmo-800 to-osmo-900 p-4 sm:p-8">
      <div className="mx-auto max-w-7xl">
        <header className="mb-6 mt-2 flex items-center gap-3 sm:gap-4">
          <img
            src="/Osmosis_Icon.png"
            alt="OSMOscope logo"
            className="h-12 w-12 shrink-0 sm:h-16 sm:w-16"
          />
          <div>
            <h1 className="text-2xl font-bold leading-tight text-white sm:text-4xl">
              OSMOscope
            </h1>
            <p className="text-sm text-osmo-200 sm:text-base">
              Tokenomics in focus
            </p>
          </div>
        </header>

        <OsmosisDashboard />
      </div>
    </main>
  );
}
