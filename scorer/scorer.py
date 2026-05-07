import math
import time
import tomllib

PRIOR = -0.5

WEIGHTS = {
    # Positive — evidence of ghostliness
    "cpu_activity_while_idle": +0.2,
    "cpu_zscore":              +0.3,
    "external_connections":    +0.9,
    "lineage_score":           +1.2,
    "process_age_days":        +0.4,
    # Negative — evidence of legitimacy
    "known_system_path":       -1.5,
    "known_system_parent":     -0.8,
    "stable_cpu_variance":     -0.4,
    "short_lived":             -0.5,
}

KNOWN_SYSTEM_PARENTS = {
    "services.exe", "svchost.exe", "explorer.exe", "wininit.exe",
    "winlogon.exe", "lsass.exe", "csrss.exe", "smss.exe", "System", "Registry"
}

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
    return min((time.time() - s.spawn_time_unix) / 86400.0, 30.0)


def sig_known_system_path(s) -> float:
    return 1.0 if s.exe_path.lower().startswith(SYSTEM_PATH_PREFIXES) else 0.0


def sig_known_system_parent(s, parent_name: str) -> float:
    return 1.0 if parent_name.lower() in KNOWN_SYSTEM_PARENTS else 0.0


def sig_stable_cpu_variance(s) -> float:
    return 1.0 if (s.cpu_std < 0.5 and s.cpu_mean < 1.0) else 0.0


def sig_short_lived(s) -> float:
    return 1.0 if (time.time() - s.spawn_time_unix) < 60 else 0.0


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------

def score(snapshot, all_pids: set[int], pid_to_name: dict[int, str]):
    from models import ProcessScore

    # Trust override — bypass model entirely
    if snapshot.exe_path.lower() in TRUSTED_PATHS:
        return ProcessScore(
            pid=snapshot.pid,
            name=snapshot.name,
            exe_path=snapshot.exe_path,
            parent_pid=snapshot.parent_pid,
            parent_name=pid_to_name.get(snapshot.parent_pid, "unknown"),
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
        "stable_cpu_variance":     sig_stable_cpu_variance(snapshot),
        "short_lived":             sig_short_lived(snapshot),
    }
    contributions = {k: WEIGHTS[k] * v for k, v in signals.items()}
    phantom_index = sigmoid(PRIOR + sum(contributions.values())) * 100.0

    with open("../config.toml", "rb") as f:
        cfg = tomllib.load(f)
    hi = cfg["scorer"]["phantom_threshold_high"]
    mid = cfg["scorer"]["phantom_threshold_medium"]
    bucket = (
        "investigate" if phantom_index >= hi
        else "watch" if phantom_index >= mid
        else "normal"
    )

    return ProcessScore(
        pid=snapshot.pid,
        name=snapshot.name,
        exe_path=snapshot.exe_path,
        parent_pid=snapshot.parent_pid,
        parent_name=parent_name,
        phantom_index=round(phantom_index, 2),
        signal_contributions=contributions,
        bucket=bucket,
        trusted=False,
        last_updated=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    )
