use axum::{extract::State, response::Json, routing::get, Router};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::collector::{ProcessWindow, TombstonedProcess};

type ActiveStore = Arc<RwLock<HashMap<u32, ProcessWindow>>>;
type TombstoneStore = Arc<RwLock<HashMap<(u32, String), TombstonedProcess>>>;

#[derive(Clone)]
struct AppState {
    active: ActiveStore,
    tombstones: TombstoneStore,
}

// ---------------------------------------------------------------------------
// Serialisable snapshot types
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct ProcessesResponse {
    active: Vec<SnapshotOut>,
    tombstones: Vec<TombstoneOut>,
    machine_idle_ms: u64,
}

#[derive(Serialize)]
struct SnapshotOut {
    pid: u32,
    name: String,
    exe_path: String,
    parent_pid: u32,
    spawn_time_unix: u64,
    cpu_mean: f64,
    cpu_std: f64,
    cpu_current: f32,
    mem_mean: f64,
    mem_std: f64,
    mem_current: u64,
    external_connections: u32,
    machine_idle_ms: u64,
    sample_count: u64,
    tombstoned: bool,
}

#[derive(Serialize)]
struct TombstoneOut {
    pid: u32,
    name: String,
    exe_path: String,
    parent_pid: u32,
    spawn_time_unix: u64,
    cpu_mean: f64,
    cpu_std: f64,
    cpu_current: f32,
    mem_mean: f64,
    mem_std: f64,
    mem_current: u64,
    external_connections: u32,
    machine_idle_ms: u64,
    sample_count: u64,
    tombstoned: bool,
    died_at: u64,
}

fn window_to_snapshot(w: &ProcessWindow) -> SnapshotOut {
    SnapshotOut {
        pid: w.pid,
        name: w.name.clone(),
        exe_path: w.exe_path.clone(),
        parent_pid: w.parent_pid,
        spawn_time_unix: w.spawn_time_unix,
        cpu_mean: w.cpu_mean,
        cpu_std: w.cpu_std,
        cpu_current: w.cpu_current,
        mem_mean: w.mem_mean,
        mem_std: w.mem_std,
        mem_current: w.mem_current,
        external_connections: w.external_connections,
        machine_idle_ms: w.machine_idle_ms,
        sample_count: w.sample_count,
        tombstoned: false,
    }
}

fn tombstone_to_out(ts: &TombstonedProcess) -> TombstoneOut {
    let w = &ts.window;
    TombstoneOut {
        pid: w.pid,
        name: w.name.clone(),
        exe_path: w.exe_path.clone(),
        parent_pid: w.parent_pid,
        spawn_time_unix: w.spawn_time_unix,
        cpu_mean: w.cpu_mean,
        cpu_std: w.cpu_std,
        cpu_current: w.cpu_current,
        mem_mean: w.mem_mean,
        mem_std: w.mem_std,
        mem_current: w.mem_current,
        external_connections: w.external_connections,
        machine_idle_ms: w.machine_idle_ms,
        sample_count: w.sample_count,
        tombstoned: true,
        died_at: ts.died_at,
    }
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async fn get_processes(State(state): State<AppState>) -> Json<ProcessesResponse> {
    let active_map = state.active.read().await;
    let tombstone_map = state.tombstones.read().await;

    let active_snapshots: Vec<SnapshotOut> = active_map.values().map(window_to_snapshot).collect();

    // Collect machine_idle_ms from the most-recently updated active process
    let machine_idle_ms = active_map
        .values()
        .next()
        .map(|w| w.machine_idle_ms)
        .unwrap_or(0);

    let tombstone_snapshots: Vec<TombstoneOut> =
        tombstone_map.values().map(tombstone_to_out).collect();

    Json(ProcessesResponse {
        active: active_snapshots,
        tombstones: tombstone_snapshots,
        machine_idle_ms,
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
    addr: &str,
) -> anyhow::Result<()> {
    let state = AppState { active, tombstones };

    let app = Router::new()
        .route("/processes", get(get_processes))
        .route("/health", get(health))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
