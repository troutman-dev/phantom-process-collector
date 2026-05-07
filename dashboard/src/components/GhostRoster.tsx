import React, { useState } from "react";
import type { LineageNode, RosterEntry, SystemStats } from "../types";
import { getLineage, trustProcess } from "../api/client";

interface Props {
  entries: RosterEntry[];
  systemStats: SystemStats | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BUCKET_COLORS: Record<string, string> = {
  investigate: "bg-mb-error/15 text-mb-error border border-mb-error/30",
  watch: "bg-mb-warning/15 text-mb-warning border border-mb-warning/30",
  normal: "bg-mb-secondary/15 text-mb-secondary border border-mb-secondary/30",
};

const PHANTOM_COLOR = (idx: number) =>
  idx >= 70 ? "#F87171" : idx >= 40 ? "#FBBF24" : "#34D399";

const UTIL_COLOR = (pct: number) =>
  pct >= 80 ? "#F87171" : pct >= 50 ? "#FBBF24" : "#34D399";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
}

function formatAge(spawnTimeUnix: number): string {
  if (spawnTimeUnix === 0) return "—";
  const seconds = Math.floor(Date.now() / 1000 - spawnTimeUnix);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

// ---------------------------------------------------------------------------
// Sort config
// ---------------------------------------------------------------------------

type SortKey =
  | "phantomIndex"
  | "cpuCurrent"
  | "memCurrent"
  | "diskRead"
  | "diskWrite"
  | "externalConnections"
  | "spawnTimeUnix"
  | "name";

type SortDir = "desc" | "asc";

function sortEntries(entries: RosterEntry[], key: SortKey, dir: SortDir): RosterEntry[] {
  return [...entries].sort((a, b) => {
    let av: number | string, bv: number | string;
    switch (key) {
      case "phantomIndex":        av = a.phantomIndex;         bv = b.phantomIndex;         break;
      case "cpuCurrent":          av = a.cpuCurrent;           bv = b.cpuCurrent;           break;
      case "memCurrent":          av = a.memCurrent;           bv = b.memCurrent;           break;
      case "diskRead":            av = a.diskReadBytes;        bv = b.diskReadBytes;        break;
      case "diskWrite":           av = a.diskWriteBytes;       bv = b.diskWriteBytes;       break;
      case "externalConnections": av = a.externalConnections;  bv = b.externalConnections;  break;
      case "spawnTimeUnix":       av = a.spawnTimeUnix;        bv = b.spawnTimeUnix;        break;
      case "name":                av = a.name.toLowerCase();   bv = b.name.toLowerCase();   break;
    }
    if (av < bv) return dir === "asc" ? -1 : 1;
    if (av > bv) return dir === "asc" ? 1 : -1;
    return 0;
  });
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function LineageDrawer({ node }: { node: LineageNode }) {
  return (
    <div className="ml-4 border-l-2 border-mb-accent/30 pl-3">
      <div className="flex items-center gap-2 py-1" style={{ color: PHANTOM_COLOR(node.phantomIndex) }}>
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



function SortableTh({
  label, sortKey, current, dir, onSort, className = "",
}: {
  label: string; sortKey: SortKey; current: SortKey; dir: SortDir;
  onSort: (k: SortKey) => void; className?: string;
}) {
  const active = current === sortKey;
  return (
    <th
      className={`px-3 py-2 text-left text-xs font-medium uppercase tracking-wider cursor-pointer select-none whitespace-nowrap ${
        active ? "text-mb-accent" : "text-mb-textSecondary hover:text-mb-textPrimary"
      } ${className}`}
      onClick={() => onSort(sortKey)}
    >
      {label}
      <span className="ml-1 opacity-60">{active ? (dir === "desc" ? "↓" : "↑") : "⇅"}</span>
    </th>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function GhostRoster({ entries, systemStats }: Props) {
  const [lineage, setLineage] = useState<LineageNode | null>(null);
  const [selectedPid, setSelectedPid] = useState<number | null>(null);
  const [trustedPids, setTrustedPids] = useState<Set<number>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>("phantomIndex");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const cpuPct = systemStats?.systemCpuPct ?? 0;
  const memUsedGb = (systemStats?.systemMemUsedBytes ?? 0) / 1_073_741_824;
  const memTotalGb = (systemStats?.systemMemTotalBytes ?? 1) / 1_073_741_824;
  const memPct = memTotalGb > 0 ? (memUsedGb / memTotalGb) * 100 : 0;
  const numCpus = systemStats?.numCpus ?? 1;

  const handleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else { setSortKey(key); setSortDir("desc"); }
  };

  const sorted = sortEntries(entries, sortKey, sortDir);

  const handleRowClick = async (pid: number) => {
    if (selectedPid === pid) { setSelectedPid(null); setLineage(null); return; }
    setSelectedPid(pid);
    try { setLineage(await getLineage(pid)); } catch { setLineage(null); }
  };

  const handleTrust = async (e: React.MouseEvent, entry: RosterEntry) => {
    e.stopPropagation();
    await trustProcess(entry.exePath);
    setTrustedPids((prev) => new Set([...prev, entry.pid]));
  };

  const COLSPAN = 12;

  return (
    <div className="space-y-3">
      {/* System utilization bar */}
      <div className="flex items-center gap-6 rounded-lg border border-mb-accent/20 bg-mb-surface px-5 py-3">
        <span className="text-mb-textSecondary uppercase tracking-wider text-xs font-semibold shrink-0">System</span>
        <div className="flex items-center gap-2 flex-1">
          <span className="text-mb-textSecondary w-8 text-xs shrink-0">CPU</span>
          <div className="flex-1 h-2 bg-mb-bg rounded-full overflow-hidden">
            <div className="h-full rounded-full transition-all duration-500" style={{ width: `${Math.min(cpuPct, 100)}%`, backgroundColor: UTIL_COLOR(cpuPct) }} />
          </div>
          <span className="font-mono text-xs w-24 text-right shrink-0" style={{ color: UTIL_COLOR(cpuPct) }}>
            {cpuPct.toFixed(1)}% ({numCpus}C)
          </span>
        </div>
        <div className="flex items-center gap-2 flex-1">
          <span className="text-mb-textSecondary w-8 text-xs shrink-0">RAM</span>
          <div className="flex-1 h-2 bg-mb-bg rounded-full overflow-hidden">
            <div className="h-full rounded-full transition-all duration-500" style={{ width: `${Math.min(memPct, 100)}%`, backgroundColor: UTIL_COLOR(memPct) }} />
          </div>
          <span className="font-mono text-xs w-36 text-right shrink-0" style={{ color: UTIL_COLOR(memPct) }}>
            {memUsedGb.toFixed(1)} / {memTotalGb.toFixed(1)} GB
          </span>
        </div>
      </div>

      {/* Process table */}
      <div className="overflow-x-auto rounded-lg border border-mb-accent/20">
        <table className="min-w-full divide-y divide-mb-accent/10 text-sm">
          <thead className="bg-mb-surface">
            <tr>
              <th className="px-3 py-2 text-left text-xs font-medium text-mb-textSecondary uppercase tracking-wider w-8">#</th>
              <SortableTh label="Name"    sortKey="name"                current={sortKey} dir={sortDir} onSort={handleSort} />
              <th className="px-3 py-2 text-left text-xs font-medium text-mb-textSecondary uppercase tracking-wider">Path</th>
              <SortableTh label="Phantom" sortKey="phantomIndex"        current={sortKey} dir={sortDir} onSort={handleSort} />
              <th className="px-3 py-2 text-left text-xs font-medium text-mb-textSecondary uppercase tracking-wider">Bucket</th>
              <SortableTh label="CPU %"   sortKey="cpuCurrent"          current={sortKey} dir={sortDir} onSort={handleSort} />
              <SortableTh label="Memory"  sortKey="memCurrent"          current={sortKey} dir={sortDir} onSort={handleSort} />
              <SortableTh label="Disk R"  sortKey="diskRead"            current={sortKey} dir={sortDir} onSort={handleSort} />
              <SortableTh label="Disk W"  sortKey="diskWrite"           current={sortKey} dir={sortDir} onSort={handleSort} />
              <SortableTh label="Net"     sortKey="externalConnections" current={sortKey} dir={sortDir} onSort={handleSort} />
              <SortableTh label="Age"     sortKey="spawnTimeUnix"       current={sortKey} dir={sortDir} onSort={handleSort} />
              <th className="px-3 py-2 text-left text-xs font-medium text-mb-textSecondary uppercase tracking-wider">Trust</th>
            </tr>
          </thead>
          <tbody className="bg-mb-bg divide-y divide-mb-accent/10">
            {sorted.map((entry, idx) => {
              const cpuNorm = numCpus > 0 ? entry.cpuCurrent / numCpus : entry.cpuCurrent;
              return (
                <React.Fragment key={entry.pid}>
                  <tr
                    className={`cursor-pointer transition-colors ${
                      selectedPid === entry.pid ? "bg-mb-accent/10" : "hover:bg-mb-surface/60"
                    }`}
                    onClick={() => handleRowClick(entry.pid)}
                  >
                    <td className="px-3 py-2 text-mb-textSecondary text-xs">{idx + 1}</td>
                    <td className="px-3 py-2 font-medium text-mb-textPrimary whitespace-nowrap">{entry.name}</td>
                    <td className="px-3 py-2 text-mb-textSecondary max-w-[160px]">
                      <span title={entry.exePath} className="truncate block text-xs">{entry.exePath}</span>
                    </td>
                    {/* Phantom Index */}
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <div className="w-16 h-2 bg-mb-surface rounded-full overflow-hidden shrink-0">
                          <div className="h-full rounded-full transition-all duration-500"
                            style={{ width: `${entry.phantomIndex}%`, backgroundColor: PHANTOM_COLOR(entry.phantomIndex) }} />
                        </div>
                        <span className="text-xs font-mono w-9 text-right text-mb-textSecondary">
                          {entry.phantomIndex.toFixed(1)}
                        </span>
                      </div>
                    </td>
                    {/* Bucket */}
                    <td className="px-3 py-2">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${BUCKET_COLORS[entry.bucket] ?? ""}`}>
                        {entry.bucket}
                      </span>
                    </td>
                    {/* CPU */}
                    <td className="px-3 py-2 text-mb-textSecondary text-xs font-mono">{cpuNorm.toFixed(1)}%</td>
                    {/* Memory */}
                    <td className="px-3 py-2 text-mb-textSecondary text-xs font-mono">{formatBytes(entry.memCurrent)}</td>
                    {/* Disk R */}
                    <td className="px-3 py-2 text-mb-textSecondary text-xs font-mono whitespace-nowrap">
                      {formatBytes(entry.diskReadBytes)}
                    </td>
                    {/* Disk W */}
                    <td className="px-3 py-2 text-mb-textSecondary text-xs font-mono whitespace-nowrap">
                      {formatBytes(entry.diskWriteBytes)}
                    </td>
                    {/* Net */}
                    <td className="px-3 py-2 text-mb-textPrimary text-xs font-mono">{entry.externalConnections}</td>
                    {/* Age */}
                    <td className="px-3 py-2 text-mb-textSecondary font-mono text-xs">{formatAge(entry.spawnTimeUnix)}</td>
                    {/* Trust */}
                    <td className="px-3 py-2">
                      {trustedPids.has(entry.pid) || entry.trusted ? (
                        <span title="Trusted" className="text-mb-accent">🛡️</span>
                      ) : (
                        <button
                          className="text-xs text-mb-textSecondary hover:text-mb-accent border border-mb-accent/20 hover:border-mb-accent/60 rounded px-2 py-0.5 transition-colors"
                          onClick={(e) => handleTrust(e, entry)}
                        >
                          Trust
                        </button>
                      )}
                    </td>
                  </tr>
                  {selectedPid === entry.pid && lineage && (
                    <tr>
                      <td colSpan={COLSPAN} className="px-6 py-3 bg-mb-surface/50 border-b border-mb-accent/10">
                        <p className="text-xs font-semibold text-mb-textSecondary mb-2 uppercase tracking-wider">Process Lineage</p>
                        <LineageDrawer node={lineage} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={COLSPAN} className="px-3 py-8 text-center text-mb-textSecondary">
                  No processes to display. Waiting for collector data…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

