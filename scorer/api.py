import asyncio
import time
import tomllib
from typing import Optional

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from models import LineageNode, ProcessScore, ProcessSnapshot, RosterEntry
import scorer as scorer_module

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
_collector_status: str = "ok"

# ---------------------------------------------------------------------------
# Collector client
# ---------------------------------------------------------------------------

def _collector_url() -> str:
    with open("../config.toml", "rb") as f:
        cfg = tomllib.load(f)
    return f"http://127.0.0.1:{cfg['ports']['collector']}"


async def _fetch_and_score() -> tuple[list[ProcessScore], str]:
    """Fetch from collector, score everything, return (scores, status)."""
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            resp = await client.get(f"{_collector_url()}/processes")
            resp.raise_for_status()
            data = resp.json()
    except Exception:
        return [], "unavailable"

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

    scores: list[ProcessScore] = [
        scorer_module.score(s, all_pids, pid_to_name) for s in snapshots
    ]
    return scores, "ok"


async def _refresh_cache():
    global _score_cache, _cache_timestamp, _collector_status
    scores, status = await _fetch_and_score()
    _collector_status = status
    if scores:
        _score_cache = scores
        _cache_timestamp = time.time()
    elif time.time() - _cache_timestamp > _CACHE_TTL_S:
        _score_cache = []
        _collector_status = "unavailable"


# ---------------------------------------------------------------------------
# Background update loop
# ---------------------------------------------------------------------------

@app.on_event("startup")
async def start_background_loop():
    async def loop():
        with open("../config.toml", "rb") as f:
            cfg = tomllib.load(f)
        interval_s = cfg["scorer"]["update_interval_s"]
        while True:
            await _refresh_cache()
            await asyncio.sleep(interval_s)

    asyncio.create_task(loop())


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/scores", response_model=list[ProcessScore])
async def get_scores():
    await _refresh_cache()
    return _score_cache


@app.get("/roster", response_model=list[RosterEntry])
async def get_roster():
    await _refresh_cache()
    sorted_scores = sorted(_score_cache, key=lambda s: s.phantom_index, reverse=True)
    return sorted_scores[:50]


@app.get("/lineage/{pid}", response_model=LineageNode)
async def get_lineage(pid: int):
    await _refresh_cache()
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


@app.post("/trust")
async def trust_process(body: TrustRequest):
    scorer_module.TRUSTED_PATHS.add(body.exe_path.lower())
    return {"trusted": body.exe_path}
