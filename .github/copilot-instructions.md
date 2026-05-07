# Phantom Process Monitor — Copilot Instructions

## What This Is
Local-first Windows process observability tool. Detects ghost processes — background
software with no plausible active user context. Each process is scored via a
log-linear Bayesian model producing a Phantom Index (0–100).

## Architecture
Three native Windows layers, no containers:
1. collector/ — Rust. Polls telemetry via sysinfo. REST on :7070. Read-only.
2. scorer/    — Python FastAPI. Bayesian scoring. REST on :8008.
3. dashboard/ — React/TypeScript SPA via Vite. Polls scorer. :5173.

Data flow: collector → scorer → dashboard. Dashboard never calls collector.

## Scoring Model
PRIOR = -0.5. sigmoid(PRIOR + sum(WEIGHTS[k] * signal_k)) * 100.

Positive signals: cpu_activity_while_idle (+0.2), cpu_zscore (+0.3),
external_connections (+0.9), lineage_score (+1.2), process_age_days (+0.4).

Negative signals: known_system_path (-1.5), known_system_parent (-0.8),
stable_cpu_variance (-0.4), short_lived (-0.5).

Buckets from config.toml: >= threshold_high → investigate, >= threshold_medium
→ watch, else → normal.

## Dead PID Handling
Dead PIDs → tombstone map keyed on (pid, exe_path), TTL 60s.
Same (pid, exe_path) revived → restore to active window.
Same pid, different exe_path → PID reuse, new process.

## Trust Override
POST /trust adds exe_path to TRUSTED_PATHS set.
Trusted processes bypass scoring entirely: phantom_index=0, trusted=True.
In-memory only — resets on restart.

## Constraints
- No external API calls anywhere in the stack
- All ports from config.toml — never hardcoded
- TypeScript types in types/index.ts mirror Pydantic schemas in models.py
  exactly (snake_case → camelCase)
- CORS on scorer: localhost:5173 only, never "*"
- /roster returns top 50 sorted by phantom_index desc
- /scores returns all ProcessScore objects unordered — used by Timeline
- Scoring logic only in scorer.py — not in api.py, not in collector

## Do Not
- Hardcode ports
- Put scoring logic outside scorer.py
- Call collector from dashboard
- Use "*" for CORS
- Add cloud dependencies or outbound telemetry
