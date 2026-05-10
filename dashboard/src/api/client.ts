import type { LineageNode, RosterEntry, SystemStats } from "../types";

const BASE = import.meta.env.VITE_SCORER_URL as string;

function requireOk(r: Response): Response {
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${r.url}`);
  return r;
}

export const getRoster = (): Promise<RosterEntry[]> =>
  fetch(`${BASE}/roster`).then(requireOk).then((r) => r.json());

export const getLineage = (pid: number): Promise<LineageNode> =>
  fetch(`${BASE}/lineage/${pid}`).then(requireOk).then((r) => r.json());

export const trustProcess = (exePath: string): Promise<void> =>
  fetch(`${BASE}/trust`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ exe_path: exePath }),
  }).then(requireOk).then(() => undefined);

export const getSystem = (): Promise<SystemStats> =>
  fetch(`${BASE}/system`).then(requireOk).then((r) => r.json());
