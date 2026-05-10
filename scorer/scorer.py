import logging
import math
import time

logger = logging.getLogger("scorer")

PRIOR = -0.15  # was -0.5 — raised to surface more borderline background processes

# Thresholds are set once at startup by api.py via set_thresholds(); defaults
# match config.toml values so the scorer is safe even if the setter is never called.
_THRESHOLD_HIGH: float = 70.0
_THRESHOLD_MEDIUM: float = 40.0


def set_thresholds(high: float, medium: float) -> None:
    """Receive thresholds from the single config.toml read performed by api.py."""
    global _THRESHOLD_HIGH, _THRESHOLD_MEDIUM
    _THRESHOLD_HIGH = high
    _THRESHOLD_MEDIUM = medium

WEIGHTS = {
    # Positive — evidence of ghostliness
    "cpu_activity_while_idle": +0.2,
    "cpu_zscore":              +0.3,
    "external_connections":    +0.4,  # was +0.9 — browsers legitimately hold many connections; reduce to avoid inflating user-facing apps
    "lineage_score":           +1.2,
    "process_age_days":        +0.7,  # was +0.4 — boost long-running silent background processes
    # Negative — evidence of legitimacy
    "known_system_path":       -1.5,
    "known_system_parent":     -0.8,  # reverted — reduction lifted Windows internals (csrss, winlogon) into top 50
    "known_user_app":          -2.0,
    "stable_cpu_variance":     -0.2,  # was -0.4 — quiet CPU is a trait of phantom processes, not a sign of legitimacy
    "short_lived":             -0.5,
}

# Windows kernel / pseudo-processes — no exe path, not scoreable as phantoms.
# Returned with phantom_index=0 without running the model.
KNOWN_PSEUDO_PROCESSES = {
    "idle", "system", "registry", "secure system",
    "memory compression", "vmmem",
}

# Core Windows session processes that frequently report no exe_path, so
# path-based suppression (known_system_path) never fires for them.
# Treat the same as pseudo-processes — always phantom_index=0.
KNOWN_SYSTEM_PROCESSES = {
    "csrss.exe", "winlogon.exe", "wininit.exe", "smss.exe",
    "lsass.exe", "services.exe", "fontdrvhost.exe", "dwm.exe",
    "audiodg.exe", "spoolsv.exe", "taskhostw.exe",
}

# Populated at startup by configure() from [scorer.signals] in config.toml.
KNOWN_USER_APPS: set[str] = set()
KNOWN_SYSTEM_PARENTS: set[str] = set()


def configure(known_user_apps: set[str], known_system_parents: set[str]) -> None:
    """Set signal sets from config.toml. Called once by api.py at startup."""
    global KNOWN_USER_APPS, KNOWN_SYSTEM_PARENTS
    KNOWN_USER_APPS = known_user_apps
    KNOWN_SYSTEM_PARENTS = known_system_parents

SYSTEM_PATH_PREFIXES = (
    "c:\\windows\\system32\\",
    "c:\\windows\\syswow64\\",
    "c:\\windows\\",
)

TRUSTED_PATHS: set[str] = set()


def sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


# ---------------------------------------------------------------------------
# Signal functions
# ---------------------------------------------------------------------------

def sig_cpu_activity_while_idle(s) -> float:
    return 1.0 if s.machine_idle_ms > 300_000 else 0.0


def sig_cpu_zscore(s) -> float:
    z = (s.cpu_current - s.cpu_mean) / (s.cpu_std + 1e-6)
    return max(-3.0, min(3.0, z))


def sig_external_connections(s) -> float:
    return min(float(s.external_connections), 5.0)


def sig_lineage_score(s, all_pids: set[int]) -> float:
    return 1.0 if (s.parent_pid == 0 or s.parent_pid not in all_pids) else 0.0


def sig_process_age_days(s) -> float:
    if s.spawn_time_unix == 0:
        return 0.0  # unknown spawn time — treat as neutral, not ancient
    return min((time.time() - s.spawn_time_unix) / 86400.0, 7.0)


def sig_known_system_path(s) -> float:
    return 1.0 if s.exe_path.lower().startswith(SYSTEM_PATH_PREFIXES) else 0.0


def sig_known_system_parent(s, parent_name: str) -> float:
    return 1.0 if parent_name.lower() in KNOWN_SYSTEM_PARENTS else 0.0


def sig_known_user_app(s) -> float:
    return 1.0 if s.name.lower() in KNOWN_USER_APPS else 0.0


def sig_stable_cpu_variance(s) -> float:
    return 1.0 if (s.cpu_std < 0.5 and s.cpu_mean < 1.0) else 0.0


def sig_short_lived(s) -> float:
    return 1.0 if (time.time() - s.spawn_time_unix) < 60 else 0.0


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------

def score(snapshot, all_pids: set[int], pid_to_name: dict[int, str]):
    from models import ProcessScore

    # Pseudo-process override — kernel/system pseudo-processes are never phantoms
    if snapshot.pid == 0 or snapshot.name.lower() in KNOWN_PSEUDO_PROCESSES or snapshot.name.lower() in KNOWN_SYSTEM_PROCESSES:
        return ProcessScore(
            pid=snapshot.pid,
            name=snapshot.name,
            exe_path=snapshot.exe_path,
            parent_pid=snapshot.parent_pid,
            parent_name=pid_to_name.get(snapshot.parent_pid, "unknown"),
            spawn_time_unix=snapshot.spawn_time_unix,
            cpu_current=snapshot.cpu_current,
            mem_current=snapshot.mem_current,
            disk_read_bytes=snapshot.disk_read_bytes,
            disk_write_bytes=snapshot.disk_write_bytes,
            external_connections=snapshot.external_connections,
            phantom_index=0.0,
            signal_contributions={},
            bucket="normal",
            trusted=False,
            last_updated=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        )

    # Trust override — bypass model entirely
    if snapshot.exe_path.lower() in TRUSTED_PATHS:
        return ProcessScore(
            pid=snapshot.pid,
            name=snapshot.name,
            exe_path=snapshot.exe_path,
            parent_pid=snapshot.parent_pid,
            parent_name=pid_to_name.get(snapshot.parent_pid, "unknown"),
            spawn_time_unix=snapshot.spawn_time_unix,
            cpu_current=snapshot.cpu_current,
            mem_current=snapshot.mem_current,
            disk_read_bytes=snapshot.disk_read_bytes,
            disk_write_bytes=snapshot.disk_write_bytes,
            external_connections=snapshot.external_connections,
            phantom_index=0.0,
            signal_contributions={},
            bucket="normal",
            trusted=True,
            last_updated=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        )

    parent_name = pid_to_name.get(snapshot.parent_pid, "unknown")

    signals = {
        "cpu_activity_while_idle": sig_cpu_activity_while_idle(snapshot),
        "cpu_zscore":              sig_cpu_zscore(snapshot),
        "external_connections":    sig_external_connections(snapshot),
        "lineage_score":           sig_lineage_score(snapshot, all_pids),
        "process_age_days":        sig_process_age_days(snapshot),
        "known_system_path":       sig_known_system_path(snapshot),
        "known_system_parent":     sig_known_system_parent(snapshot, parent_name),
        "known_user_app":          sig_known_user_app(snapshot),
        "stable_cpu_variance":     sig_stable_cpu_variance(snapshot),
        "short_lived":             sig_short_lived(snapshot),
    }
    contributions = {k: WEIGHTS[k] * v for k, v in signals.items()}
    phantom_index = sigmoid(PRIOR + sum(contributions.values())) * 100.0

    logger.debug(
        "pid=%-6d  %-30s  phantom=%6.2f  spawn=%d  exe=%r",
        snapshot.pid, snapshot.name, phantom_index,
        snapshot.spawn_time_unix, snapshot.exe_path or "<empty>",
    )
    logger.debug("  signals: %s", {
        k: f"{v:+.3f}" for k, v in contributions.items() if v != 0
    })

    bucket = (
        "investigate" if phantom_index >= _THRESHOLD_HIGH
        else "watch" if phantom_index >= _THRESHOLD_MEDIUM
        else "normal"
    )

    return ProcessScore(
        pid=snapshot.pid,
        name=snapshot.name,
        exe_path=snapshot.exe_path,
        parent_pid=snapshot.parent_pid,
        parent_name=parent_name,
        spawn_time_unix=snapshot.spawn_time_unix,
        cpu_current=snapshot.cpu_current,
        mem_current=snapshot.mem_current,
        disk_read_bytes=snapshot.disk_read_bytes,
        disk_write_bytes=snapshot.disk_write_bytes,
        external_connections=snapshot.external_connections,
        phantom_index=round(phantom_index, 2),
        signal_contributions=contributions,
        bucket=bucket,
        trusted=False,
        last_updated=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    )
