export interface ProcessSnapshot {
  pid: number;
  name: string;
  exePath: string;
  parentPid: number;
  cpuMean: number;
  cpuStd: number;
  cpuCurrent: number;
  memMean: number;
  memStd: number;
  memCurrent: number;
  externalConnections: number;
  spawnTimeUnix: number;
  machineIdleMs: number;
  sampleCount: number;
  tombstoned: boolean;
}

export interface ProcessScore {
  pid: number;
  name: string;
  exePath: string;
  parentPid: number;
  parentName: string;
  phantomIndex: number;
  signalContributions: Record<string, number>;
  bucket: "investigate" | "watch" | "normal";
  trusted: boolean;
  lastUpdated: string;
}

export type RosterEntry = ProcessScore;

export interface LineageNode {
  pid: number;
  name: string;
  phantomIndex: number;
  children: LineageNode[];
}
