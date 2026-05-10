use anyhow::Result;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

mod api;
mod collector;

use collector::{ProcessWindow, TombstonedProcess};

#[derive(Debug, serde::Deserialize)]
struct Config {
    ports: PortsConfig,
    collector: CollectorConfig,
}

#[derive(Debug, serde::Deserialize)]
struct PortsConfig {
    collector: u16,
}

#[derive(Debug, serde::Deserialize)]
struct CollectorConfig {
    poll_interval_ms: u64,
}

#[tokio::main]
async fn main() -> Result<()> {
    // Parse optional --config flag
    let config_path = std::env::args()
        .skip_while(|a| a != "--config")
        .nth(1)
        .unwrap_or_else(|| "../config.toml".to_string());

    let config_str = std::fs::read_to_string(&config_path)
        .unwrap_or_else(|_| std::fs::read_to_string("config.toml").expect("config.toml not found"));

    let cfg: Config = toml::from_str(&config_str)?;

    let active: Arc<RwLock<HashMap<u32, ProcessWindow>>> =
        Arc::new(RwLock::new(HashMap::new()));
    let tombstones: Arc<RwLock<HashMap<(u32, String), TombstonedProcess>>> =
        Arc::new(RwLock::new(HashMap::new()));
    let system_stats: Arc<RwLock<(f32, u64, u64, u32, u64)>> =
        Arc::new(RwLock::new((0.0, 0, 0, 0u32, 0u64)));

    let poll_ms = cfg.collector.poll_interval_ms;
    let active_clone = active.clone();
    let tombstones_clone = tombstones.clone();
    let system_stats_poll = system_stats.clone();

    tokio::spawn(async move {
        collector::polling_loop(active_clone, tombstones_clone, system_stats_poll, poll_ms).await;
    });

    let addr = format!("127.0.0.1:{}", cfg.ports.collector);
    api::serve(active, tombstones, system_stats, &addr).await?;

    Ok(())
}
