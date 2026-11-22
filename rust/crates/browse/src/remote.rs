//! A browser on another computer (cli/src/setup/remote.ts, `set hostname`): the relay listens on every network, and the
//! user enters this computer's address and a one-time pairing code in browse there.

use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::Context;
use serde_json::{Value, json};

use crate::{browsers, relay, relay_api, update};
use browse_relay::pairing;

fn config_file() -> PathBuf {
    relay_api::paths().relay_config()
}

pub fn hostname() -> String {
    std::fs::read(config_file()).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).and_then(|v| v["hostname"].as_str().map(|hostname| hostname.trim().to_owned())).unwrap_or_else(|| "127.0.0.1".into())
}

/// Whether the relay listens on every network, so browsers on other computers can pair with it.
pub fn is_open() -> bool {
    hostname() == "0.0.0.0"
}

/// Saves where the relay listens and restarts a running relay so it takes effect. Returns false when a running relay
/// couldn't be restarted.
fn set(hostname: &str) -> anyhow::Result<bool> {
    let file = config_file();
    let mut config = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).filter(Value::is_object).unwrap_or_else(|| json!({}));
    config["hostname"] = json!(hostname);
    update::write_private(&file, format!("{config:#}\n").as_bytes())?;
    relay::restart()
}

fn tailnet(ip: &Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    a == 100 && (64..=127).contains(&b)
}

/// This computer's non-loopback IPv4 addresses, skipping interfaces whose names look like container and VM bridges.
/// Names are a heuristic: inside a container these are the container's own addresses, not the computer the browser
/// runs on, and a firewall or NAT can still keep one from being reachable.
#[cfg(unix)]
fn interfaces() -> Vec<Ipv4Addr> {
    let mut found = Vec::new();
    let mut list: *mut libc::ifaddrs = std::ptr::null_mut();
    // SAFETY: getifaddrs fills a linked list we only read and then free with freeifaddrs.
    unsafe {
        if libc::getifaddrs(&mut list) != 0 {
            return found;
        }
        let mut next = list;
        while !next.is_null() {
            let entry = &*next;
            next = entry.ifa_next;
            if entry.ifa_addr.is_null() || i32::from((*entry.ifa_addr).sa_family) != libc::AF_INET {
                continue;
            }
            let name = std::ffi::CStr::from_ptr(entry.ifa_name).to_string_lossy();
            let virtual_ = ["lo", "docker", "br-", "veth", "virbr", "vmnet", "vboxnet", "cni", "flannel", "podman", "utun", "awdl", "llw", "bridge"];
            if virtual_.iter().any(|p| name.starts_with(p)) {
                continue;
            }
            let address = &*(entry.ifa_addr as *const libc::sockaddr_in);
            let ip = Ipv4Addr::from(u32::from_be(address.sin_addr.s_addr));
            if !ip.is_loopback() && !ip.is_link_local() && !found.contains(&ip) {
                found.push(ip);
            }
        }
        libc::freeifaddrs(list);
    }
    found
}

#[cfg(not(unix))]
fn interfaces() -> Vec<Ipv4Addr> {
    Vec::new()
}

/// Whether Linux root markers say this is a container: Docker writes /.dockerenv and Podman /run/.containerenv.
fn container_marker(docker: bool, podman: bool) -> bool {
    docker || podman
}

/// Whether WSL says so: Windows sets WSL_DISTRO_NAME, and its kernel release contains "microsoft".
fn wsl_marker(distro: Option<&str>, release: &str) -> bool {
    distro.is_some() || release.to_ascii_lowercase().contains("microsoft")
}

fn in_container() -> bool {
    cfg!(target_os = "linux") && container_marker(Path::new("/.dockerenv").exists(), Path::new("/run/.containerenv").exists())
}

fn in_wsl() -> bool {
    if !cfg!(target_os = "linux") {
        return false;
    }
    match std::env::var("WSL_DISTRO_NAME") {
        Ok(distro) => wsl_marker(Some(&distro), ""),
        Err(_) => wsl_marker(None, &std::fs::read_to_string("/proc/sys/kernel/osrelease").unwrap_or_default()),
    }
}

/// `host` with the port appended when it isn't the default one.
fn with_port(host: &str, port: u16) -> String {
    if port == relay_api::DEFAULT_PORT { host.to_owned() } else { format!("{host}:{port}") }
}

/// The addresses to offer, first the one most likely to work. On a tailnet its MagicDNS name or addresses are
/// reachable as they are. In a container the container's own address usually can't be reached from outside it, so
/// `localhost:<port>` (the forwarded port) comes first and the container's addresses follow. In WSL, Windows reaches
/// the listener on `localhost`, so it comes first there too. Otherwise the addresses stand as they are.
fn ordered(hosts: Vec<String>, port: u16, container: bool, wsl: bool, on_tailnet: bool) -> Vec<String> {
    let hosts: Vec<String> = hosts.into_iter().map(|host| with_port(&host, port)).collect();
    if on_tailnet {
        hosts
    } else if container || wsl {
        std::iter::once(with_port("localhost", port)).chain(hosts).collect()
    } else {
        hosts
    }
}

/// This computer's MagicDNS name, from the Tailscale CLI when it's installed.
fn magic_dns() -> Option<String> {
    let mac = PathBuf::from("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
    let cli = browsers::on_path("tailscale").or_else(|| (cfg!(target_os = "macos") && mac.is_file()).then_some(mac))?;
    let output = Command::new(cli).args(["status", "--json"]).output().ok()?;
    let status: Value = serde_json::from_slice(&output.stdout).ok()?;
    status.pointer("/Self/DNSName").and_then(Value::as_str).map(|n| n.trim_end_matches('.').to_owned()).filter(|n| !n.is_empty())
}

/// Where a browser on another computer reaches this relay: on a tailnet its MagicDNS name and Tailscale addresses,
/// otherwise the LAN addresses; with the port when it isn't the default.
fn addresses(port: u16, container: bool, wsl: bool) -> (Vec<String>, bool) {
    let ips = interfaces();
    let tail: Vec<&Ipv4Addr> = ips.iter().filter(|ip| tailnet(ip)).collect();
    let on_tailnet = !tail.is_empty();
    let hosts: Vec<String> = if on_tailnet { magic_dns().into_iter().chain(tail.iter().map(|ip| ip.to_string())).collect() } else { ips.iter().map(ToString::to_string).collect() };
    (ordered(hosts, port, container, wsl, on_tailnet), on_tailnet)
}

/// The lines that show the addresses to enter in browse on another computer, first the one most likely to work, and
/// in a container how to reach it.
fn address_lines(hosts: &[String], port: u16, container: bool) -> Vec<String> {
    let mut lines = vec![format!("  Relay address  {}", hosts.first().map_or("this computer's IP address", String::as_str))];
    lines.extend(hosts.iter().skip(1).map(|host| format!("             or  {host}")));
    if container {
        lines.push(format!("! browse is running in a container, so its own address above may not be reachable from outside it. Forward port {port} to the same port on the browser's computer (devcontainer \"forwardPorts\": [{port}], or docker run -p 127.0.0.1:{port}:{port}), then enter localhost:{port} there."));
    }
    lines
}

/// Prints where a browser on another computer reaches this relay. Returns whether the addresses are on a tailnet.
pub fn print_relay_addresses() -> bool {
    let port = relay_api::port();
    let container = in_container();
    let (hosts, on_tailnet) = addresses(port, container, in_wsl());
    for line in address_lines(&hosts, port, container && !on_tailnet) {
        println!("{line}");
    }
    on_tailnet
}

/// Prints what to enter in browse on the other computer: this relay's address and a fresh pairing code.
fn print_pairing(agent: bool) -> anyhow::Result<()> {
    relay::ensure()?;
    let code = pairing::mint_pairing_code(&relay_api::paths(), pairing::PAIRING_CODE_TTL_MS, Some("remote"))?;
    println!();
    println!("In Chrome on the other computer, open browse, choose \"Connect an agent on another computer\" and enter:");
    let on_tailnet = print_relay_addresses();
    println!("  Pairing code   {}", pairing::format_pairing_code(&code));
    println!();
    println!("The code works once, within {} minutes. For a new one, run: browse pair", pairing::PAIRING_CODE_TTL_MS / 60_000);
    if !on_tailnet {
        println!("! browse doesn't encrypt this connection: use it on a network you trust, or over Tailscale, not the open internet.");
    }
    if agent {
        println!("Agent: give the user the relay address and pairing code above to enter in browse in their browser. The code works once and expires; `browse pair` prints a new one.");
    }
    Ok(())
}

/// The rest of `browse install --remote`: opens the relay to other computers and prints the address and a code.
pub fn install(agent: bool) -> anyhow::Result<i32> {
    let mut status = 0;
    if is_open() {
        println!("✓ The relay is open to other computers");
    } else if set("0.0.0.0")? {
        println!("✓ Opened the relay to other computers");
    } else {
        println!("! The relay is still only reachable from this computer: it's busy. Run `browse set hostname 0.0.0.0` again once no agent is using the browser.");
        status = 1;
    }
    print_pairing(agent)?;
    Ok(status)
}

/// `browse set hostname <127.0.0.1|0.0.0.0>`.
pub fn command(args: &[String]) -> anyhow::Result<i32> {
    let value = match args {
        [key, value] if key == "hostname" => match value.trim() {
            "0.0.0.0" | "all" => Some("0.0.0.0"),
            "127.0.0.1" | "localhost" | "local" => Some("127.0.0.1"),
            _ => None,
        },
        _ => None,
    };
    let Some(value) = value else {
        eprintln!("Usage: browse set hostname <127.0.0.1|0.0.0.0>");
        eprintln!("  127.0.0.1  only browsers on this computer can connect (the default)");
        eprintln!("  0.0.0.0    browsers on other computers can connect too, after pairing");
        return Ok(2);
    };
    let restarted = set(value).context("couldn't save the relay's hostname")?;
    println!("✓ hostname is {value}");
    if !restarted {
        println!("! The relay is busy, so it keeps listening as before until it restarts. Run this again once no agent is using the browser.");
    }
    if value == "0.0.0.0" {
        print_pairing(false)?;
    }
    Ok(i32::from(!restarted))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_container_offers_the_forwarded_port_before_its_own_address() {
        assert_eq!(ordered(vec!["172.17.0.3".into()], relay_api::DEFAULT_PORT, true, false, false), ["localhost", "172.17.0.3"]);
        assert_eq!(ordered(vec!["172.17.0.3".into()], 20000, true, false, false), ["localhost:20000", "172.17.0.3:20000"]);
    }

    #[test]
    fn a_container_on_a_tailnet_offers_the_reachable_tailnet_addresses() {
        assert_eq!(ordered(vec!["dev.tailnet.ts.net".into(), "100.64.0.5".into()], relay_api::DEFAULT_PORT, true, false, true), ["dev.tailnet.ts.net", "100.64.0.5"]);
        assert_eq!(ordered(vec!["dev.tailnet.ts.net".into()], 20000, true, false, true), ["dev.tailnet.ts.net:20000"]);
    }

    #[test]
    fn wsl_offers_localhost_before_the_linux_addresses() {
        assert_eq!(ordered(vec!["172.20.0.1".into()], relay_api::DEFAULT_PORT, false, true, false), ["localhost", "172.20.0.1"]);
        assert_eq!(ordered(vec!["172.20.0.1".into()], 20000, false, true, false), ["localhost:20000", "172.20.0.1:20000"]);
    }

    #[test]
    fn a_plain_computer_keeps_its_addresses_in_order() {
        assert_eq!(ordered(vec!["192.168.1.5".into(), "10.0.0.2".into()], relay_api::DEFAULT_PORT, false, false, false), ["192.168.1.5", "10.0.0.2"]);
        assert_eq!(ordered(vec!["192.168.1.5".into()], 20000, false, false, false), ["192.168.1.5:20000"]);
    }

    #[test]
    fn a_container_prints_the_forwarded_address_then_its_own_with_what_to_do() {
        let lines = address_lines(&ordered(vec!["172.17.0.3".into()], relay_api::DEFAULT_PORT, true, false, false), relay_api::DEFAULT_PORT, true);
        assert_eq!(
            lines,
            [
                "  Relay address  localhost",
                "             or  172.17.0.3",
                "! browse is running in a container, so its own address above may not be reachable from outside it. Forward port 19988 to the same port on the browser's computer (devcontainer \"forwardPorts\": [19988], or docker run -p 127.0.0.1:19988:19988), then enter localhost:19988 there.",
            ]
        );
    }

    #[test]
    fn a_container_off_the_default_port_prints_its_port_everywhere() {
        let lines = address_lines(&ordered(vec!["172.17.0.3".into()], 20000, true, false, false), 20000, true);
        assert_eq!(
            lines,
            [
                "  Relay address  localhost:20000",
                "             or  172.17.0.3:20000",
                "! browse is running in a container, so its own address above may not be reachable from outside it. Forward port 20000 to the same port on the browser's computer (devcontainer \"forwardPorts\": [20000], or docker run -p 127.0.0.1:20000:20000), then enter localhost:20000 there.",
            ]
        );
    }

    #[test]
    fn a_container_on_a_tailnet_prints_no_forwarding_hint() {
        let hosts = ordered(vec!["dev.tailnet.ts.net".into(), "100.64.0.5".into()], relay_api::DEFAULT_PORT, true, false, true);
        assert_eq!(address_lines(&hosts, relay_api::DEFAULT_PORT, false), ["  Relay address  dev.tailnet.ts.net", "             or  100.64.0.5"]);
    }

    #[test]
    fn a_wsl_install_prints_no_forwarding_hint() {
        let hosts = ordered(vec!["172.20.0.1".into()], relay_api::DEFAULT_PORT, false, true, false);
        assert_eq!(address_lines(&hosts, relay_api::DEFAULT_PORT, false), ["  Relay address  localhost", "             or  172.20.0.1"]);
    }

    #[test]
    fn containers_and_wsl_are_detected_from_their_markers() {
        assert!(container_marker(true, false));
        assert!(container_marker(false, true));
        assert!(!container_marker(false, false));
        assert!(wsl_marker(Some("Ubuntu-22.04"), ""));
        assert!(wsl_marker(None, "6.6.87.2-microsoft-standard-WSL2"));
        assert!(wsl_marker(None, "6.6.87.2-Microsoft-standard-WSL2"));
        assert!(!wsl_marker(None, "6.6.87.1-arch1-1"));
    }
}
