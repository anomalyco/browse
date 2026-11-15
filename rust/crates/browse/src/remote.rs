//! A browser on another computer (cli/src/setup/remote.ts, `set hostname`): the relay listens on every network, and the
//! user enters this computer's address and a one-time pairing code in browse there.

use std::net::Ipv4Addr;
use std::path::PathBuf;
use std::process::Command;

use anyhow::Context;
use serde_json::{Value, json};

use crate::{browsers, relay, relay_api, update};
use browse_relay::pairing;

fn config_file() -> PathBuf {
    relay_api::paths().relay_config()
}

pub fn hostname() -> String {
    std::fs::read(config_file()).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).and_then(|v| v["hostname"].as_str().map(str::to_owned)).unwrap_or_else(|| "127.0.0.1".into())
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

/// This computer's IPv4 addresses another computer can reach, by interface name, without loopback, link-local and
/// container or VM bridges.
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
fn addresses() -> (Vec<String>, bool) {
    let ips = interfaces();
    let tail: Vec<&Ipv4Addr> = ips.iter().filter(|ip| tailnet(ip)).collect();
    let mut hosts: Vec<String> = if tail.is_empty() { ips.iter().map(ToString::to_string).collect() } else { magic_dns().into_iter().chain(tail.iter().map(|ip| ip.to_string())).collect() };
    let port = relay_api::port();
    if port != relay_api::DEFAULT_PORT {
        hosts = hosts.into_iter().map(|h| format!("{h}:{port}")).collect();
    }
    (hosts, !tail.is_empty())
}

/// Prints what to enter in browse on the other computer: this relay's address and a fresh pairing code.
fn print_pairing(agent: bool) -> anyhow::Result<()> {
    relay::ensure()?;
    let (hosts, on_tailnet) = addresses();
    let code = pairing::mint_pairing_code(&relay_api::paths(), pairing::PAIRING_CODE_TTL_MS, Some("remote"))?;
    println!();
    println!("In Chrome on the other computer, open browse, choose \"Connect an agent on another computer\" and enter:");
    println!("  Relay address  {}", hosts.first().map_or("this computer's IP address", String::as_str));
    for host in hosts.iter().skip(1) {
        println!("             or  {host}");
    }
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
    if hostname() == "0.0.0.0" {
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
