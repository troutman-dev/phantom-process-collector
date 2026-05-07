import type { LineageNode, ProcessScore, RosterEntry } from "../types";

const BASE = import.meta.env.VITE_SCORER_URL as string;

export const getRoster = (): Promise<RosterEntry[]> =>
  fetch(`${BASE}/roster`).then((r) => r.json());

export const getScores = (): Promise<ProcessScore[]> =>
  fetch(`${BASE}/scores`).then((r) => r.json());

export const getLineage = (pid: number): Promise<LineageNode> =>
  fetch(`${BASE}/lineage/${pid}`).then((r) => r.json());

export const trustProcess = (exePath: string): Promise<Response> =>
  fetch(`${BASE}/trust`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ exe_path: exePath }),
  });
