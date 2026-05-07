import { useEffect, useRef, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import type { ProcessScore } from "../types";

const MAX_HISTORY = 60; // 3 min at 3s intervals

interface HistoryEntry {
  t: number;
  cpu: number;
}

interface Props {
  scores: ProcessScore[];
}

export default function Timeline({ scores }: Props) {
  const historyRef = useRef<Map<number, HistoryEntry[]>>(new Map());
  const [, forceRender] = useState(0);

  useEffect(() => {
    const top10 = [...scores]
      .sort((a, b) => b.phantomIndex - a.phantomIndex)
      .slice(0, 10);

    const now = Date.now();
    for (const proc of top10) {
      if (!historyRef.current.has(proc.pid)) {
        historyRef.current.set(proc.pid, []);
      }
      const history = historyRef.current.get(proc.pid)!;
      // cpuCurrent is not available on ProcessScore; we use signal_contributions as proxy
      const cpuValue = proc.signalContributions?.cpu_zscore ?? 0;
      history.push({ t: now, cpu: cpuValue });
      if (history.length > MAX_HISTORY) history.shift();
    }
    forceRender((n) => n + 1);
  }, [scores]);

  const top10 = [...scores]
    .sort((a, b) => b.phantomIndex - a.phantomIndex)
    .slice(0, 10);

  if (top10.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-400">
        No process data yet. Waiting for scorer…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {top10.map((proc) => {
        const history = historyRef.current.get(proc.pid) ?? [];
        const color =
          proc.phantomIndex >= 70
            ? "#ef4444"
            : proc.phantomIndex >= 40
            ? "#f59e0b"
            : "#22c55e";

        return (
          <div key={proc.pid} className="bg-white rounded-lg border border-gray-200 p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="font-medium text-gray-900 text-sm">{proc.name}</span>
                <span className="text-xs text-gray-400 font-mono">PID {proc.pid}</span>
              </div>
              <span
                className="text-sm font-bold font-mono"
                style={{ color }}
              >
                {proc.phantomIndex.toFixed(1)}
              </span>
            </div>
            <ResponsiveContainer width="100%" height={60}>
              <LineChart data={history}>
                <XAxis dataKey="t" hide />
                <YAxis domain={[-3, 3]} hide />
                <Tooltip
                  formatter={(v: number) => [v.toFixed(2), "CPU z-score"]}
                  labelFormatter={() => ""}
                />
                <Line
                  type="monotone"
                  dataKey="cpu"
                  stroke={color}
                  dot={false}
                  strokeWidth={1.5}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        );
      })}
    </div>
  );
}
