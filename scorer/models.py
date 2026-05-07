from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class ProcessSnapshot(BaseModel):
    pid: int
    name: str
    exe_path: str
    parent_pid: int
    cpu_mean: float
    cpu_std: float
    cpu_current: float
    mem_current: int
    external_connections: int
    spawn_time_unix: int
    machine_idle_ms: int
    sample_count: int
    tombstoned: bool = False
    disk_read_bytes: int = 0
    disk_write_bytes: int = 0


class ProcessScore(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    pid: int
    name: str
    exe_path: str
    parent_pid: int
    parent_name: str
    spawn_time_unix: int          # passed through from snapshot for display
    cpu_current: float            # passed through from snapshot for display
    mem_current: int              # bytes — dashboard computes %
    disk_read_bytes: int          # bytes read since last refresh
    disk_write_bytes: int         # bytes written since last refresh
    external_connections: int     # raw count, passed through for Roster column
    phantom_index: float          # 0–100
    signal_contributions: dict[str, float]
    bucket: str                   # "investigate" | "watch" | "normal"
    trusted: bool = False
    last_updated: str             # ISO timestamp


class LineageNode(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    pid: int
    name: str
    phantom_index: float
    children: list["LineageNode"] = []


LineageNode.model_rebuild()


class SystemStats(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    system_cpu_pct: float
    system_mem_used_bytes: int
    system_mem_total_bytes: int
    num_cpus: int = 1
