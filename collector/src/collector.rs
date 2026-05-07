use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::net::IpAddr;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use sysinfo::{Process, System};
use tokio::sync::RwLock;
use tokio::time::{interval, Duration};

// ---------------------------------------------------------------------------
// Data structures
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct ProcessObservation {
    pub cpu_percent: f32,
    pub memory_bytes: u64,
    pub timestamp: u64,
    pub machine_was_idle: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProcessWindow {
    // Static — set on first observation
    pub pid: u32,
    pub name: String,
    pub exe_path: String,
    pub parent_pid: u32,
    pub spawn_time_unix: u64,
    // Rolling window
    pub observations: VecDeque<ProcessObservation>,
    // Welford accumulators
    pub cpu_mean: f64,
    pub cpu_std: f64,
    pub cpu_m2: f64,
    pub mem_mean: f64,
    pub mem_std: f64,
    pub mem_m2: f64,
    pub sample_count: u64,
    // Current tick values
    pub cpu_current: f32,
    pub mem_current: u64,
    pub external_connections: u32,
    pub machine_idle_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct TombstonedProcess {
    pub window: ProcessWindow,
    pub died_at: u64,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Returns ms since last keyboard/mouse input (machine-wide).
/// On non-Windows platforms returns 0 (no idle signal available).
fn get_machine_idle_ms() -> u64 {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::System::SystemInformation::GetTickCount;
        use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
        unsafe {
            let mut lii = LASTINPUTINFO {
                cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
                dwTime: 0,
            };
            GetLastInputInfo(&mut lii);
            let tick_now = GetTickCount();
            (tick_now.wrapping_sub(lii.dwTime)) as u64
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        0
    }
}

/// Returns true if the address is loopback, link-local, or RFC 1918 private.
fn is_internal(addr: &IpAddr) -> bool {
    match addr {
        IpAddr::V4(a) => {
            a.is_loopback()
                || a.is_link_local()
                || a.is_private()
                || a.is_unspecified()
        }
        IpAddr::V6(a) => {
            a.is_loopback() || a.is_unspecified()
        }
    }
}

/// Count external TCP/UDP connections for a process.
/// Uses platform-specific methods where available; returns 0 otherwise.
fn count_external_connections(_proc: &Process) -> u32 {
    // sysinfo 0.30 does not expose per-process connection lists cross-platform.
    // On Windows a future upgrade to sysinfo 0.31+ or a direct netstat parse
    // would populate this field. Stubbed to 0 for portability.
    let _ = is_internal; // suppress unused-function warning
    0
}

// ---------------------------------------------------------------------------
// Welford update
// ---------------------------------------------------------------------------

impl ProcessWindow {
    fn new(pid: u32, name: String, exe_path: String, parent_pid: u32, spawn_time_unix: u64) -> Self {
        ProcessWindow {
            pid,
            name,
            exe_path,
            parent_pid,
            spawn_time_unix,
            observations: VecDeque::new(),
            cpu_mean: 0.0,
            cpu_std: 0.0,
            cpu_m2: 0.0,
            mem_mean: 0.0,
            mem_std: 0.0,
            mem_m2: 0.0,
            sample_count: 0,
            cpu_current: 0.0,
            mem_current: 0,
            external_connections: 0,
            machine_idle_ms: 0,
        }
    }

    fn update(
        &mut self,
        cpu: f32,
        mem: u64,
        external_connections: u32,
        machine_idle_ms: u64,
        window_size: usize,
    ) {
        self.cpu_current = cpu;
        self.mem_current = mem;
        self.external_connections = external_connections;
        self.machine_idle_ms = machine_idle_ms;

        // Welford for CPU
        let cpu_f = cpu as f64;
        let delta_cpu = cpu_f - self.cpu_mean;
        self.sample_count += 1;
        self.cpu_mean += delta_cpu / self.sample_count as f64;
        let delta2_cpu = cpu_f - self.cpu_mean;
        self.cpu_m2 += delta_cpu * delta2_cpu;
        self.cpu_std = (self.cpu_m2 / self.sample_count as f64).sqrt();

        // Welford for memory
        let mem_f = mem as f64;
        let delta_mem = mem_f - self.mem_mean;
        self.mem_mean += delta_mem / self.sample_count as f64;
        let delta2_mem = mem_f - self.mem_mean;
        self.mem_m2 += delta_mem * delta2_mem;
        self.mem_std = (self.mem_m2 / self.sample_count as f64).sqrt();

        // Rolling observation window
        let obs = ProcessObservation {
            cpu_percent: cpu,
            memory_bytes: mem,
            timestamp: now_ms(),
            machine_was_idle: machine_idle_ms > 300_000,
        };
        self.observations.push_back(obs);
        if self.observations.len() > window_size {
            self.observations.pop_front();
        }
    }
}

// ---------------------------------------------------------------------------
// Polling loop
// ---------------------------------------------------------------------------

pub async fn polling_loop(
    active: Arc<RwLock<HashMap<u32, ProcessWindow>>>,
    tombstones: Arc<RwLock<HashMap<(u32, String), TombstonedProcess>>>,
    poll_interval_ms: u64,
    window_size: usize,
) {
    let mut ticker = interval(Duration::from_millis(poll_interval_ms));
    let mut sys = System::new_all();

    loop {
        ticker.tick().await;
        sys.refresh_all();

        let machine_idle_ms = get_machine_idle_ms();
        let now = now_ms();

        // Collect live PIDs from sysinfo
        let mut seen_pids: HashSet<u32> = HashSet::new();

        {
            let mut active_map = active.write().await;
            let mut tombstone_map = tombstones.write().await;

            for (pid, proc) in sys.processes() {
                let pid_u32 = pid.as_u32();
                seen_pids.insert(pid_u32);

                let exe_path = proc
                    .exe()
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default();

                let cpu = proc.cpu_usage();
                let mem = proc.memory();
                let parent_pid = proc.parent().map(|p| p.as_u32()).unwrap_or(0);
                let ext_conns = count_external_connections(proc);

                // Check tombstone for revival
                let tomb_key = (pid_u32, exe_path.clone());
                if let Some(tombstoned) = tombstone_map.remove(&tomb_key) {
                    // Legitimate restart — restore history
                    let mut revived = tombstoned.window;
                    revived.update(cpu, mem, ext_conns, machine_idle_ms, window_size);
                    active_map.insert(pid_u32, revived);
                    continue;
                }

                match active_map.get_mut(&pid_u32) {
                    Some(window) => {
                        window.update(cpu, mem, ext_conns, machine_idle_ms, window_size);
                    }
                    None => {
                        // New process (or PID reuse — exe_path differs, tomb stays)
                        let spawn_time = proc
                            .start_time(); // seconds since epoch
                        let mut window = ProcessWindow::new(
                            pid_u32,
                            proc.name().to_string(),
                            exe_path,
                            parent_pid,
                            spawn_time,
                        );
                        window.update(cpu, mem, ext_conns, machine_idle_ms, window_size);
                        active_map.insert(pid_u32, window);
                    }
                }
            }

            // Move dead PIDs to tombstones
            let dead_pids: Vec<u32> = active_map
                .keys()
                .filter(|pid| !seen_pids.contains(*pid))
                .cloned()
                .collect();

            for pid in dead_pids {
                if let Some(window) = active_map.remove(&pid) {
                    let key = (pid, window.exe_path.clone());
                    tombstone_map.insert(key, TombstonedProcess { window, died_at: now });
                }
            }

            // Evict tombstones older than 60 s
            tombstone_map.retain(|_, ts| now - ts.died_at <= 60_000);
        }
    }
}
