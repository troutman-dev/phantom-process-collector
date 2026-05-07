export interface ProcessScore {
  pid: number;
  name: string;
  exePath: string;
  parentPid: number;
  parentName: string;
  spawnTimeUnix: number;
  cpuCurrent: number;
  memCurrent: number;
  diskReadBytes: number;
  diskWriteBytes: number;
  externalConnections: number;
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

export interface SystemStats {
  systemCpuPct: number;
  systemMemUsedBytes: number;
  systemMemTotalBytes: number;
  numCpus: number;
}
