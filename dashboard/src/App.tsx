import { useEffect, useState } from "react";
import GhostRoster from "./components/GhostRoster";
import Timeline from "./components/Timeline";
import { getRoster, getScores } from "./api/client";
import type { ProcessScore, RosterEntry } from "./types";

type Tab = "roster" | "timeline";

export default function App() {
  const [tab, setTab] = useState<Tab>("roster");
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [scores, setScores] = useState<ProcessScore[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchAll() {
      try {
        const [r, s] = await Promise.all([getRoster(), getScores()]);
        setRoster(r);
        setScores(s);
        setError(null);
      } catch (e) {
        setError("Cannot reach scorer. Is it running?");
      }
    }

    fetchAll();
    const id = setInterval(fetchAll, 3000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-2xl">👻</span>
          <h1 className="text-xl font-bold text-gray-900">Phantom Process Monitor</h1>
        </div>
        {error && (
          <span className="text-sm text-red-600 bg-red-50 px-3 py-1 rounded-full border border-red-200">
            {error}
          </span>
        )}
      </header>

      {/* Tabs */}
      <nav className="bg-white border-b border-gray-200 px-6">
        <div className="flex gap-1">
          {(["roster", "timeline"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                tab === t
                  ? "border-blue-500 text-blue-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              {t === "roster" ? "Ghost Roster" : "Timeline"}
            </button>
          ))}
        </div>
      </nav>

      {/* Content */}
      <main className="p-6">
        {tab === "roster" && <GhostRoster entries={roster} />}
        {tab === "timeline" && <Timeline scores={scores} />}
      </main>
    </div>
  );
}
