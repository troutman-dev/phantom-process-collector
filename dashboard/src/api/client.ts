import type { LineageNode, RosterEntry, SystemStats } from "../types";

const BASE = import.meta.env.VITE_SCORER_URL as string;
const TRUST_TOKEN = import.meta.env.VITE_TRUST_TOKEN as string | undefined;

function requireOk(r: Response): Response {
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${r.url}`);
  return r;
}

export const getRoster = (): Promise<RosterEntry[]> =>
  fetch(`${BASE}/roster`).then(requireOk).then((r) => r.json());

export const getLineage = (pid: number): Promise<LineageNode> =>
  fetch(`${BASE}/lineage/${pid}`).then(requireOk).then((r) => r.json());

export const trustProcess = (exePath: string): Promise<Response> => {
  if (!TRUST_TOKEN) throw new Error("Trust token not configured — start via run.ps1");
  return fetch(`${BASE}/trust`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Trust-Token": TRUST_TOKEN,
    },
    body: JSON.stringify({ exe_path: exePath }),
  });
};

export const getSystem = (): Promise<SystemStats> =>
  fetch(`${BASE}/system`).then(requireOk).then((r) => r.json());
