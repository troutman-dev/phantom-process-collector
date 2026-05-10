use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use sysinfo::System;
use tokio::sync::RwLock;
use tokio::time::{interval, Duration};

// ---------------------------------------------------------------------------
// Data structures
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct ProcessWindow {
    // Static — set on first observation
    pub pid: u32,
    pub name: String,
    pub exe_path: String,
    pub parent_pid: u32,
    pub spawn_time_unix: u64,
    // Welford accumulators
    pub cpu_mean: f64,
    pub cpu_std: f64,
    pub cpu_m2: f64,
    pub sample_count: u64,
    // Current tick values
    pub cpu_current: f32,
    pub mem_current: u64,
    pub external_connections: u32,
    pub machine_idle_ms: u64,
    pub disk_read_bytes: u64,
    pub disk_write_bytes: u64,
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
            let _ = GetLastInputInfo(&mut lii);
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

/// Count external TCP connections for a process using GetExtendedTcpTable.
/// Covers both IPv4 (AF_INET) and IPv6 (AF_INET6). Returns 0 on non-Windows.
fn count_external_connections(pid: u32) -> u32 {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::NetworkManagement::IpHelper::{
            GetExtendedTcpTable,
            MIB_TCP6ROW_OWNER_PID, MIB_TCP6TABLE_OWNER_PID,
            MIB_TCPROW_OWNER_PID, MIB_TCPTABLE_OWNER_PID,
            TCP_TABLE_OWNER_PID_ALL,
        };
        use windows::Win32::Networking::WinSock::{AF_INET, AF_INET6};

        let mut count: u32 = 0;

        unsafe {
            // --- IPv4 ---
            let mut size: u32 = 0;
            let _ = GetExtendedTcpTable(None, &mut size, false, AF_INET.0 as u32, TCP_TABLE_OWNER_PID_ALL, 0);
            if size > 0 {
                let mut buf: Vec<u8> = vec![0u8; size as usize];
                let result = GetExtendedTcpTable(
                    Some(buf.as_mut_ptr() as *mut _),
                    &mut size,
                    false,
                    AF_INET.0 as u32,
                    TCP_TABLE_OWNER_PID_ALL,
                    0,
                );
                if result == 0 {
                    let table = &*(buf.as_ptr() as *const MIB_TCPTABLE_OWNER_PID);
                    // SAFETY: MIB_TCPTABLE_OWNER_PID ends with a 1-element array; actual
                    // rows follow contiguously in the buffer we allocated.
                    let rows: &[MIB_TCPROW_OWNER_PID] = std::slice::from_raw_parts(
                        table.table.as_ptr(),
                        table.dwNumEntries as usize,
                    );
                    count += rows.iter()
                        .filter(|row| row.dwOwningPid == pid)
                        .filter(|row| {
                            let addr = u32::from_be(row.dwRemoteAddr);
                            let ip = std::net::Ipv4Addr::from(addr.to_be_bytes());
                            !is_internal(&std::net::IpAddr::V4(ip))
                        })
                        .count() as u32;
                }
            }

            // --- IPv6 ---
            let mut size6: u32 = 0;
            let _ = GetExtendedTcpTable(None, &mut size6, false, AF_INET6.0 as u32, TCP_TABLE_OWNER_PID_ALL, 0);
            if size6 > 0 {
                let mut buf6: Vec<u8> = vec![0u8; size6 as usize];
                let result6 = GetExtendedTcpTable(
                    Some(buf6.as_mut_ptr() as *mut _),
                    &mut size6,
                    false,
                    AF_INET6.0 as u32,
                    TCP_TABLE_OWNER_PID_ALL,
                    0,
                );
                if result6 == 0 {
                    let table6 = &*(buf6.as_ptr() as *const MIB_TCP6TABLE_OWNER_PID);
                    // SAFETY: same trailing-array layout as the IPv4 table.
                    let rows6: &[MIB_TCP6ROW_OWNER_PID] = std::slice::from_raw_parts(
                        table6.table.as_ptr(),
                        table6.dwNumEntries as usize,
                    );
                    count += rows6.iter()
                        .filter(|row| row.dwOwningPid == pid)
                        .filter(|row| {
                            let ip = std::net::Ipv6Addr::from(row.ucRemoteAddr);
                            !is_internal(&std::net::IpAddr::V6(ip))
                        })
                        .count() as u32;
                }
            }
        }

        count
    }
    #[cfg(not(target_os = "windows"))]
    {
        0
    }
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
            cpu_mean: 0.0,
            cpu_std: 0.0,
            cpu_m2: 0.0,
            sample_count: 0,
            cpu_current: 0.0,
            mem_current: 0,
            external_connections: 0,
            machine_idle_ms: 0,
            disk_read_bytes: 0,
            disk_write_bytes: 0,
        }
    }

    fn update(
        &mut self,
        cpu: f32,
        mem: u64,
        external_connections: u32,
        machine_idle_ms: u64,
        disk_read_bytes: u64,
        disk_write_bytes: u64,
    ) {
        self.cpu_current = cpu;
        self.mem_current = mem;
        self.external_connections = external_connections;
        self.machine_idle_ms = machine_idle_ms;
        self.disk_read_bytes = disk_read_bytes;
        self.disk_write_bytes = disk_write_bytes;

        // Welford for CPU — sample variance (N-1) once we have >1 observation
        let cpu_f = cpu as f64;
        let delta_cpu = cpu_f - self.cpu_mean;
        self.sample_count += 1;
        self.cpu_mean += delta_cpu / self.sample_count as f64;
        let delta2_cpu = cpu_f - self.cpu_mean;
        self.cpu_m2 += delta_cpu * delta2_cpu;
        self.cpu_std = if self.sample_count > 1 {
            (self.cpu_m2 / (self.sample_count - 1) as f64).sqrt()
        } else {
            0.0
        };
    }
}

// ---------------------------------------------------------------------------
// Polling loop
// ---------------------------------------------------------------------------

pub async fn polling_loop(
    active: Arc<RwLock<HashMap<u32, ProcessWindow>>>,
    tombstones: Arc<RwLock<HashMap<(u32, String), TombstonedProcess>>>,
    system_stats: Arc<RwLock<(f32, u64, u64, u32)>>,
    poll_interval_ms: u64,
) {
    let mut ticker = interval(Duration::from_millis(poll_interval_ms));
    let mut sys = System::new_all();
    // Previous (busy_ticks, total_ticks) for delta-based CPU% via GetSystemTimes.
    // Initialised to 0; first loop iteration sets the baseline, second gives real data.
    let mut _cpu_prev: (u64, u64) = (0, 0);

    loop {
        ticker.tick().await;
        sys.refresh_all();

        let cpu_count = sys.cpus().len().max(1) as u32;

        #[cfg(target_os = "windows")]
        let cpu_pct = {
            use windows::Win32::Foundation::FILETIME;
            use windows::Win32::System::Threading::GetSystemTimes;
            unsafe {
                let mut idle = FILETIME::default();
                let mut kernel = FILETIME::default();
                let mut user = FILETIME::default();
                if GetSystemTimes(Some(&mut idle as *mut _), Some(&mut kernel as *mut _), Some(&mut user as *mut _)).is_ok() {
                    let idle_t = ((idle.dwHighDateTime as u64) << 32) | idle.dwLowDateTime as u64;
                    let kernel_t = ((kernel.dwHighDateTime as u64) << 32) | kernel.dwLowDateTime as u64;
                    let user_t = ((user.dwHighDateTime as u64) << 32) | user.dwLowDateTime as u64;
                    let total = kernel_t + user_t;
                    let busy = total - idle_t;
                    let (prev_busy, prev_total) = _cpu_prev;
                    let delta_busy = busy.saturating_sub(prev_busy);
                    let delta_total = total.saturating_sub(prev_total);
                    _cpu_prev = (busy, total);
                    if delta_total == 0 { 0.0 } else { (delta_busy as f32 / delta_total as f32) * 100.0 }
                } else {
                    0.0
                }
            }
        };
        #[cfg(not(target_os = "windows"))]
        let cpu_pct = sys.cpus().iter().map(|c| c.cpu_usage()).sum::<f32>() / cpu_count as f32;

        {
            let mut stats = system_stats.write().await;
            *stats = (cpu_pct, sys.used_memory(), sys.total_memory(), cpu_count);
        }

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
                let ext_conns = count_external_connections(pid_u32);
                let disk = proc.disk_usage();
                let disk_read = disk.read_bytes;
                let disk_write = disk.written_bytes;

                // Check tombstone for revival
                let tomb_key = (pid_u32, exe_path.clone());
                if let Some(tombstoned) = tombstone_map.remove(&tomb_key) {
                    // Legitimate restart — restore history
                    let mut revived = tombstoned.window;
                    revived.update(cpu, mem, ext_conns, machine_idle_ms, disk_read, disk_write);
                    active_map.insert(pid_u32, revived);
                    continue;
                }

                match active_map.get_mut(&pid_u32) {
                    Some(window) => {
                        window.update(cpu, mem, ext_conns, machine_idle_ms, disk_read, disk_write);
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
                        window.update(cpu, mem, ext_conns, machine_idle_ms, disk_read, disk_write);
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
