import { useEffect, useState } from "react";
import GhostRoster from "./components/GhostRoster";
import { getRoster, getSystem } from "./api/client";
import type { RosterEntry, SystemStats } from "./types";

export default function App() {
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [systemStats, setSystemStats] = useState<SystemStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchAll() {
      try {
        const [r, sys] = await Promise.all([getRoster(), getSystem()]);
        setRoster(r);
        setSystemStats(sys);
        setError(null);
      } catch (e) {
        setError("Cannot reach scorer. Is it running?");
      }
    }

    fetchAll();
    const id = setInterval(fetchAll, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="min-h-screen bg-mb-bg text-mb-textPrimary">
      {/* Header */}
      <header className="bg-mb-surface border-b border-mb-accent/20 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold text-mb-textPrimary">Phantom Process Monitor</h1>
        </div>
        {error && (
          <span className="text-sm text-mb-error bg-mb-error/10 px-3 py-1 rounded-full border border-mb-error/30">
            {error}
          </span>
        )}
      </header>

      {/* Content */}
      <main className="p-6">
        <GhostRoster entries={roster} systemStats={systemStats} />
      </main>
    </div>
  );
}

