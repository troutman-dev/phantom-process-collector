from pydantic import BaseModel


class ProcessSnapshot(BaseModel):
    pid: int
    name: str
    exe_path: str
    parent_pid: int
    cpu_mean: float
    cpu_std: float
    cpu_current: float
    mem_mean: float
    mem_std: float
    mem_current: int
    external_connections: int
    spawn_time_unix: int
    machine_idle_ms: int
    sample_count: int
    tombstoned: bool = False


class ProcessScore(BaseModel):
    pid: int
    name: str
    exe_path: str
    parent_pid: int
    parent_name: str
    phantom_index: float          # 0–100
    signal_contributions: dict[str, float]
    bucket: str                   # "investigate" | "watch" | "normal"
    trusted: bool = False
    last_updated: str             # ISO timestamp


class RosterEntry(ProcessScore):
    pass  # Separate type to allow future divergence (rank, trend, etc)


class LineageNode(BaseModel):
    pid: int
    name: str
    phantom_index: float
    children: list["LineageNode"] = []


LineageNode.model_rebuild()
