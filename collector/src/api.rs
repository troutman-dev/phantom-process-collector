use axum::{extract::State, response::Json, routing::get, Router};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::collector::{ProcessWindow, TombstonedProcess};

type ActiveStore = Arc<RwLock<HashMap<u32, ProcessWindow>>>;
type TombstoneStore = Arc<RwLock<HashMap<(u32, String), TombstonedProcess>>>;
type SystemStatsStore = Arc<RwLock<(f32, u64, u64, u32, u64)>>;

#[derive(Clone)]
struct AppState {
    active: ActiveStore,
    tombstones: TombstoneStore,
    system_stats: SystemStatsStore,
}

// ---------------------------------------------------------------------------
// Serialisable snapshot types
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct ProcessesResponse {
    active: Vec<ProcessOut>,
    tombstones: Vec<ProcessOut>,
    machine_idle_ms: u64,
    system_cpu_pct: f32,
    system_mem_used_bytes: u64,
    system_mem_total_bytes: u64,
    num_cpus: u32,
}

#[derive(Serialize)]
struct ProcessOut {
    pid: u32,
    name: String,
    exe_path: String,
    parent_pid: u32,
    spawn_time_unix: u64,
    cpu_mean: f64,
    cpu_std: f64,
    cpu_current: f32,
    mem_current: u64,
    external_connections: u32,
    machine_idle_ms: u64,
    sample_count: u64,
    tombstoned: bool,
    disk_read_bytes: u64,
    disk_write_bytes: u64,
}

fn process_out(w: &ProcessWindow, tombstoned: bool) -> ProcessOut {
    ProcessOut {
        pid: w.pid,
        name: w.name.clone(),
        exe_path: w.exe_path.clone(),
        parent_pid: w.parent_pid,
        spawn_time_unix: w.spawn_time_unix,
        cpu_mean: w.cpu_mean,
        cpu_std: w.cpu_std,
        cpu_current: w.cpu_current,
        mem_current: w.mem_current,
        external_connections: w.external_connections,
        machine_idle_ms: w.machine_idle_ms,
        sample_count: w.sample_count,
        tombstoned,
        disk_read_bytes: w.disk_read_bytes,
        disk_write_bytes: w.disk_write_bytes,
    }
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async fn get_processes(State(state): State<AppState>) -> Json<ProcessesResponse> {
    let active_map = state.active.read().await;
    let tombstone_map = state.tombstones.read().await;
    let (system_cpu_pct, system_mem_used_bytes, system_mem_total_bytes, num_cpus, machine_idle_ms) =
        *state.system_stats.read().await;

    let active_snapshots: Vec<ProcessOut> =
        active_map.values().map(|w| process_out(w, false)).collect();

// Collect machine_idle_ms from the most-recently updated active process
let machine_idle_ms = active_map
    .values()
    .next()
    .map(|w| w.machine_idle_ms)
    .unwrap_or(0);

let tombstone_snapshots: Vec<ProcessOut> = tombstone_map
    .values()
    .map(|ts| process_out(&ts.window, true))
    .collect();

Json(ProcessesResponse {
    active: active_snapshots,
    tombstones: tombstone_snapshots,
    machine_idle_ms,
    system_cpu_pct,
    system_mem_used_bytes,
    system_mem_total_bytes,
    num_cpus,
})
}

async fn health() -> Json<Value> {
    Json(json!({ "status": "ok" }))
}

// ---------------------------------------------------------------------------
// Server entry point
// ---------------------------------------------------------------------------

pub async fn serve(
    active: ActiveStore,
    tombstones: TombstoneStore,
    system_stats: SystemStatsStore,
    addr: &str,
) -> anyhow::Result<()> {
    let state = AppState { active, tombstones, system_stats };

    let app = Router::new()
        .route("/processes", get(get_processes))
        .route("/health", get(health))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
