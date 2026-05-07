import React, { useState } from "react";
import type { LineageNode, RosterEntry } from "../types";
import { getLineage, trustProcess } from "../api/client";

interface Props {
  entries: RosterEntry[];
}

const BUCKET_COLORS: Record<string, string> = {
  investigate: "bg-red-100 text-red-800",
  watch: "bg-yellow-100 text-yellow-800",
  normal: "bg-green-100 text-green-800",
};

function formatAge(spawnTimeUnix: number): string {
  const seconds = Math.floor(Date.now() / 1000 - spawnTimeUnix);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function LineageDrawer({ node }: { node: LineageNode }) {
  return (
    <div className="ml-4 border-l-2 border-gray-300 pl-3">
      <div
        className="flex items-center gap-2 py-1"
        style={{
          color: node.phantomIndex >= 70 ? "#ef4444" : node.phantomIndex >= 40 ? "#f59e0b" : "#22c55e",
        }}
      >
        <span className="font-mono text-sm">{node.pid}</span>
        <span className="text-sm font-medium">{node.name}</span>
        <span className="text-xs opacity-75">{node.phantomIndex.toFixed(1)}</span>
      </div>
      {node.children.map((child) => (
        <LineageDrawer key={child.pid} node={child} />
      ))}
    </div>
  );
}

export default function GhostRoster({ entries }: Props) {
  const [lineage, setLineage] = useState<LineageNode | null>(null);
  const [selectedPid, setSelectedPid] = useState<number | null>(null);
  const [trustedPids, setTrustedPids] = useState<Set<number>>(new Set());

  const handleRowClick = async (pid: number) => {
    if (selectedPid === pid) {
      setSelectedPid(null);
      setLineage(null);
      return;
    }
    setSelectedPid(pid);
    try {
      const node = await getLineage(pid);
      setLineage(node);
    } catch {
      setLineage(null);
    }
  };

  const handleTrust = async (e: React.MouseEvent, entry: RosterEntry) => {
    e.stopPropagation();
    await trustProcess(entry.exePath);
    setTrustedPids((prev) => new Set([...prev, entry.pid]));
  };

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200 text-sm">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">#</th>
            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Name</th>
            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Path</th>
            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Phantom Index</th>
            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Bucket</th>
            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Ext. Conns</th>
            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Age</th>
            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Trust</th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-100">
          {entries.map((entry, idx) => (
            <React.Fragment key={entry.pid}>
              <tr
                className={`cursor-pointer hover:bg-gray-50 transition-colors ${selectedPid === entry.pid ? "bg-blue-50" : ""}`}
                onClick={() => handleRowClick(entry.pid)}
              >
                <td className="px-3 py-2 text-gray-500">{idx + 1}</td>
                <td className="px-3 py-2 font-medium text-gray-900">{entry.name}</td>
                <td className="px-3 py-2 text-gray-500 max-w-xs">
                  <span title={entry.exePath} className="truncate block">
                    {entry.exePath}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-2 bg-gray-200 rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all duration-500"
                        style={{
                          width: `${entry.phantomIndex}%`,
                          backgroundColor:
                            entry.phantomIndex >= 70
                              ? "#ef4444"
                              : entry.phantomIndex >= 40
                              ? "#f59e0b"
                              : "#22c55e",
                        }}
                      />
                    </div>
                    <span className="text-xs font-mono w-10 text-right">
                      {entry.phantomIndex.toFixed(1)}
                    </span>
                  </div>
                </td>
                <td className="px-3 py-2">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${BUCKET_COLORS[entry.bucket] ?? ""}`}>
                    {entry.bucket}
                  </span>
                </td>
                <td className="px-3 py-2 text-gray-700">{entry.signalContributions?.external_connections?.toFixed(1) ?? "—"}</td>
                <td className="px-3 py-2 text-gray-500 font-mono text-xs">
                  {formatAge(0)}
                </td>
                <td className="px-3 py-2">
                  {trustedPids.has(entry.pid) || entry.trusted ? (
                    <span title="Trusted" className="text-blue-500 text-lg">🛡️</span>
                  ) : (
                    <button
                      className="text-xs text-gray-400 hover:text-blue-600 border border-gray-200 rounded px-2 py-0.5"
                      onClick={(e) => handleTrust(e, entry)}
                    >
                      Trust
                    </button>
                  )}
                </td>
              </tr>
              {selectedPid === entry.pid && lineage && (
                <tr>
                  <td colSpan={8} className="px-6 py-3 bg-gray-50 border-b">
                    <p className="text-xs font-semibold text-gray-500 mb-2 uppercase tracking-wider">Process Lineage</p>
                    <LineageDrawer node={lineage} />
                  </td>
                </tr>
              )}
            </React.Fragment>
          ))}
          {entries.length === 0 && (
            <tr>
              <td colSpan={8} className="px-3 py-8 text-center text-gray-400">
                No processes to display. Waiting for collector data…
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
