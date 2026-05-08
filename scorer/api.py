import asyncio
import logging
import logging.handlers
import os
import re
import secrets
import time
import tomllib

import httpx
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, field_validator

from models import LineageNode, ProcessScore, ProcessSnapshot, SystemStats
import scorer as scorer_module

# ---------------------------------------------------------------------------
# Config — read once at startup
# ---------------------------------------------------------------------------

with open("../config.toml", "rb") as _f:
    _config = tomllib.load(_f)

COLLECTOR_URL = f"http://127.0.0.1:{_config['ports']['collector']}"
_UPDATE_INTERVAL_S: int = _config["scorer"]["update_interval_s"]

# ---------------------------------------------------------------------------
# Logging — configured once, respects config.toml [logging] level
# ---------------------------------------------------------------------------

_log_level_str: str = _config.get("logging", {}).get("level", "info").upper()
_log_level: int = getattr(logging, _log_level_str, logging.INFO)
_logs_dir: str = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "logs"))
os.makedirs(_logs_dir, exist_ok=True)

logging.basicConfig(
    level=_log_level,
    format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
    handlers=[
        logging.handlers.RotatingFileHandler(
            os.path.join(_logs_dir, "scorer.log"),
            maxBytes=1_000_000,
            backupCount=3,
            encoding="utf-8",
        ),
        logging.StreamHandler(),
    ],
)

_logger = logging.getLogger("api")

# ---------------------------------------------------------------------------
# Trust token — loaded (or generated) once at startup
# ---------------------------------------------------------------------------

_token_path = os.path.join(_logs_dir, "trust_token.txt")

def _load_or_create_trust_token() -> str:
    try:
        with open(_token_path) as _tf:
            token = _tf.read().strip()
        if token:
            _logger.info("Loaded trust token from %s", _token_path)
            return token
    except FileNotFoundError:
        pass
    token = secrets.token_hex(32)
    with open(_token_path, "w") as _tf:
        _tf.write(token)
    _logger.info("Generated new trust token → %s", _token_path)
    return token

_TRUST_TOKEN: str = _load_or_create_trust_token()

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

app = FastAPI(title="Phantom Scorer")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# In-memory cache
# ---------------------------------------------------------------------------

_score_cache: list[ProcessScore] = []
_cache_timestamp: float = 0.0
_CACHE_TTL_S = 10.0
_system_stats_cache: SystemStats = SystemStats(
    system_cpu_pct=0.0,
    system_mem_used_bytes=0,
    system_mem_total_bytes=0,
)
# Tombstones are scored once on first sight then frozen — keyed on (pid, exe_path).
_tombstone_scores: dict[tuple[int, str], ProcessScore] = {}
# Guard: prevents two concurrent calls from both executing _fetch_and_score.
_refreshing: bool = False

# ---------------------------------------------------------------------------
# Collector client
# ---------------------------------------------------------------------------


async def _fetch_and_score() -> list[ProcessScore]:
    """Fetch from collector, score everything, and return scored results."""
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            resp = await client.get(f"{COLLECTOR_URL}/processes")
            resp.raise_for_status()
            data = resp.json()
    except Exception:
        return []

    global _system_stats_cache
    _system_stats_cache = SystemStats(
        system_cpu_pct=data.get("system_cpu_pct", 0.0),
        system_mem_used_bytes=data.get("system_mem_used_bytes", 0),
        system_mem_total_bytes=data.get("system_mem_total_bytes", 0),
        num_cpus=data.get("num_cpus", 1),
    )

    active_raw = data.get("active", [])
    tombstone_raw = data.get("tombstones", [])
    all_raw = active_raw + tombstone_raw

    snapshots: list[ProcessSnapshot] = []
    for item in all_raw:
        try:
            snapshots.append(ProcessSnapshot(**item))
        except Exception:
            continue

    all_pids: set[int] = {s.pid for s in snapshots}
    pid_to_name: dict[int, str] = {s.pid: s.name for s in snapshots}

    # Diagnostic: surface data-quality issues that will corrupt scores.
    zero_spawn  = [s for s in snapshots if s.spawn_time_unix == 0 and not s.tombstoned]
    empty_exe   = [s for s in snapshots if not s.exe_path and not s.tombstoned]
    _logger.info(
        "Scoring %d processes (%d active / %d tombstoned) — "
        "spawn_time=0: %d, empty_exe_path: %d",
        len(snapshots), len(active_raw), len(tombstone_raw),
        len(zero_spawn), len(empty_exe),
    )
    if zero_spawn:
        _logger.warning(
            "spawn_time_unix=0 for %d processes — process_age_days signal fires at MAX (+%.1f). "
            "Examples: %s",
            len(zero_spawn),
            scorer_module.WEIGHTS["process_age_days"] * 30,
            ", ".join(f"{s.name}(pid={s.pid})" for s in zero_spawn[:5]),
        )
    if empty_exe:
        _logger.warning(
            "Empty exe_path for %d processes — known_system_path signal suppressed. "
            "Examples: %s",
            len(empty_exe),
            ", ".join(f"{s.name}(pid={s.pid})" for s in empty_exe[:5]),
        )

    scores: list[ProcessScore] = []
    current_tomb_keys: set[tuple[int, str]] = set()

    for s in snapshots:
        if s.tombstoned:
            key = (s.pid, s.exe_path)
            current_tomb_keys.add(key)
            cached = _tombstone_scores.get(key)
            if cached is not None:
                scores.append(cached)
            else:
                # Score once on first sight, then freeze.
                new_score = scorer_module.score(s, all_pids, pid_to_name)
                _tombstone_scores[key] = new_score
                scores.append(new_score)
        else:
            # Process is alive — evict from tombstone cache if it was revived.
            _tombstone_scores.pop((s.pid, s.exe_path), None)
            scores.append(scorer_module.score(s, all_pids, pid_to_name))

    # Evict tombstone cache entries the collector has expired (TTL 60 s).
    for key in list(_tombstone_scores.keys()):
        if key not in current_tomb_keys:
            del _tombstone_scores[key]

    return scores


async def _refresh_cache():
    global _score_cache, _cache_timestamp, _refreshing
    if _refreshing:
        return
    _refreshing = True
    try:
        scores = await _fetch_and_score()
        if scores:
            _score_cache = scores
            _cache_timestamp = time.time()
        elif time.time() - _cache_timestamp > _CACHE_TTL_S:
            _score_cache = []
    finally:
        _refreshing = False


# ---------------------------------------------------------------------------
# Background update loop
# ---------------------------------------------------------------------------

@app.on_event("startup")
async def start_background_loop():
    async def loop():
        while True:
            await _refresh_cache()
            await asyncio.sleep(_UPDATE_INTERVAL_S)

    asyncio.create_task(loop())


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/scores", response_model=list[ProcessScore], response_model_by_alias=True)
async def get_scores():
    return _score_cache


@app.get("/roster", response_model=list[ProcessScore], response_model_by_alias=True)
async def get_roster():
    sorted_scores = sorted(_score_cache, key=lambda s: s.phantom_index, reverse=True)
    return sorted_scores[:50]


@app.get("/lineage/{pid}", response_model=LineageNode, response_model_by_alias=True)
async def get_lineage(pid: int):
    pid_to_score: dict[int, ProcessScore] = {s.pid: s for s in _score_cache}

    if pid not in pid_to_score:
        raise HTTPException(status_code=404, detail="PID not found")

    def build_node(current_pid: int, visited: set[int]) -> LineageNode:
        if current_pid in visited:
            # Guard against cycles
            s = pid_to_score[current_pid]
            return LineageNode(pid=s.pid, name=s.name, phantom_index=s.phantom_index)
        visited = visited | {current_pid}
        s = pid_to_score[current_pid]
        children = [
            build_node(child.pid, visited)
            for child in pid_to_score.values()
            if child.parent_pid == current_pid and child.pid != current_pid
        ]
        return LineageNode(
            pid=s.pid,
            name=s.name,
            phantom_index=s.phantom_index,
            children=children,
        )

    node = build_node(pid, set())
    return node


class TrustRequest(BaseModel):
    exe_path: str

    @field_validator("exe_path")
    @classmethod
    def validate_exe_path(cls, v: str) -> str:
        if not v:
            raise ValueError("exe_path must not be empty")
        if len(v) > 512:
            raise ValueError("exe_path must be ≤ 512 characters")
        if "\x00" in v:
            raise ValueError("exe_path must not contain null bytes")
        if any(part == ".." for part in re.split(r"[/\\]", v)):
            raise ValueError("exe_path must not contain path traversal sequences")
        if not (re.match(r"^[A-Za-z]:[/\\]", v) or v.startswith("/") or v.startswith("\\\\")):
            raise ValueError("exe_path must be an absolute path")
        return v


@app.get("/system", response_model=SystemStats, response_model_by_alias=True)
async def get_system():
    return _system_stats_cache


@app.post("/trust")
async def trust_process(
    body: TrustRequest,
    x_trust_token: str | None = Header(default=None),
):
    if x_trust_token != _TRUST_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid or missing trust token")
    scorer_module.TRUSTED_PATHS.add(body.exe_path.lower())
    return {"trusted": body.exe_path}
