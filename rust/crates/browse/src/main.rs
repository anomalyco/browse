mod agents;
mod browsers;
mod cli;
mod dsh;
mod firefox;
mod http;
mod install;
mod jsonc;
mod legacy;
mod mcp;
mod method;
mod picker;
mod protocol;
mod relay;
mod relay_api;
mod remote;
mod serve;
mod session;
mod setup;
mod update;

pub const VERSION: &str = match option_env!("BROWSE_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};

/// Commands main dispatches itself, after its own argument handling; tools are not here because `browse <tool>
/// --help` is the tool parser's own. A help flag anywhere in one of these commands' arguments prints usage instead.
const COMMANDS: &[&str] = &[
    "version",
    "serve",
    "mcp",
    "install",
    "uninstall",
    "set",
    "restart",
    "pair",
    "extension",
    "firefox",
    "disconnect",
    "update",
    "status",
    "runtime-switch",
    "tools",
];

/// Whether `command`'s arguments ask for help. A setup command or update would otherwise act on the flag, and
/// everything after `--` belongs to another program, so it is not a help request for browse.
fn asked_for_help(command: &str, args: &[String]) -> bool {
    COMMANDS.contains(&command) && args.iter().take_while(|arg| arg.as_str() != "--").any(|arg| arg == "--help" || arg == "-h")
}

const HELP: &str = "browse lets your AI agents use your real browser: Chrome-family browsers through the browse extension, and
Firefox-family browsers through WebDriver BiDi.

SETUP
  install                     Install browse, add it to your agents and connect the extension
    -a, --agent <name>...     Set up these agents without asking (opencode, claude, codex, cursor, ...; '*' for
                              all, 'none' to print the MCP entry instead)
    -y, --yes                 Set up every agent found on this computer without asking
    --remote                  The browser is on another computer: open the relay to the network and print its
                              address and a pairing code
    --no-open                 Print the steps without opening anything
    --no-wait                 Don't wait for the extension to connect
    --wait-seconds <seconds>  How long to wait (default 180 in a terminal, 90 otherwise)
    --no-modify-path          Don't add browse to PATH
    --firefox                 Connect a Firefox-family browser instead of the Chrome extension
  extension                   Where to get the extension
  firefox                     Connect a Firefox-family browser directly, starting it with remote control when needed
    --app <firefox|dev|nightly|zen|path>
                              Which app (default: the one connected before, else the first installed)
    --profile <name|dir>      Which profile (default: the one connected before, else the running or default one)
    --relaunch                Restart a running Firefox with remote control; its tabs come back, private windows don't
    --dedicated               Use a separate browse profile instead of yours
    --headless                A dedicated profile with no window (browse disconnect quits it)
    --url <ws://...>          Connect a WebDriver BiDi endpoint that's already listening
  disconnect [browser]        Let a directly connected browser go; browse stops reconnecting it
  pair [--wait-seconds <s>]   Print a one-time pairing code and wait for the browser that redeems it
    --list                    Show paired browsers
    --revoke <browser>        Unpair a browser (its id, name or profile)
  set hostname <127.0.0.1|0.0.0.0>
                              Who can reach the relay: this computer only (default), or other computers too
  update [--check]            Update now, or only check
    --mode <on|notify|off>    Automatic updates (OPENCODE_BROWSER_AUTO_UPDATE overrides)
  status [--json]             Setup, relay and extension state
  uninstall                   Remove browse from your agents, stop the relay and delete its files
  version                     Print the version

RUNNING
  serve                       Run the relay in the foreground (agents start it on demand)
  restart                     Restart the relay with this terminal's environment; agent tabs stay open
  mcp                         The MCP server agents run (stdio)
  tools                       List the browser tools
  <tool> [value]... [--arg value]...
                              Call a tool. `browse navigate https://example.com` opens a tab and prints its id
                              (\"tab\"); pass it to the rest: `browse snapshot --tab 12`, `browse click e12 --tab 12`,
                              `browse fill e5 hello --tab 12`, `browse tabs close --tab 12`.
                              Values fill the tool's main options (see `browse <tool> --help`)
    --tab <id>                The tab to act on: a tab id from navigate or `browse tabs`, or a chosen id like
                              `work-mail` from `tabs new`
    --json '<object>'         Arguments as one JSON object
    --output <path>           Where to save images (default: a temp file, printed)
  <tool> --help               The tool's options
  execute --file <script.js>  Run a JavaScript file (Playwright-style `page`, snapshot(), ref(), handoff(), browse.*);
                              --code '<js>' or a positional value runs inline code, --file - reads stdin.
                              It prints the tab it ended in; --tab <id> continues there
";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // Global flags may come before the tool name: `browse --tab 12 snapshot`.
    let (globals, mut args) = cli::split_globals(&args);
    if !globals.is_empty() && args.first().is_some_and(|a| !a.starts_with('-')) {
        let tail = args.split_off(1);
        args.extend(globals);
        args.extend(tail);
    } else if !globals.is_empty() {
        eprintln!("{} goes with a tool, e.g. `browse snapshot {}`. Run `browse --help`.", globals[0], globals.join(" "));
        std::process::exit(2);
    }
    let command = args.first().map(String::as_str).unwrap_or("--help");
    // `browse status | head` should end quietly, not panic on a closed pipe. The relay and the MCP server keep
    // SIGPIPE ignored: a peer that went away is an error to handle there.
    #[cfg(unix)]
    if command != "serve" && command != "mcp" {
        unsafe {
            libc::signal(libc::SIGPIPE, libc::SIG_DFL);
        }
    }
    let rest = args.get(1..).unwrap_or_default();
    let result = match command {
        "--help" | "-h" | "help" => {
            print!("{HELP}");
            Ok(0)
        }
        // `browse update --help` and the like print usage instead of acting. Tool commands parse `--help` themselves
        // (cli.rs), so they are not in COMMANDS.
        command if asked_for_help(command, rest) => {
            print!("{HELP}");
            Ok(0)
        }
        "--version" | "-v" | "version" => {
            println!("{VERSION}");
            Ok(0)
        }
        "serve" => serve::run(),
        "mcp" => mcp::run().map(|_| 0),
        "install" => install::install(rest),
        "uninstall" => install::uninstall(rest),
        "set" => remote::command(rest),
        "restart" => relay::stop().and_then(|_| relay::ensure()).map(|_| {
            println!("✓ The relay restarted");
            0
        }),
        "pair" => setup::pair(rest),
        "extension" => Ok(setup::extension()),
        "firefox" => firefox::command(rest),
        "disconnect" => firefox::disconnect(rest),
        "update" => update::command(rest).map(|_| 0),
        "status" => setup::status(rest),
        // Run by the TypeScript browse's updater once it installed this build (legacy.rs).
        "runtime-switch" => legacy::runtime_switch(rest),
        "tools" => Ok(cli::list()),
        tool if !tool.starts_with('-') => cli::call(tool, rest),
        other => {
            eprintln!("Unknown option {other}. Run `browse --help`.");
            Ok(2)
        }
    };
    let code = result.unwrap_or_else(|error| {
        eprintln!("browse: {error:#}");
        1
    });
    std::process::exit(code);
}

#[cfg(test)]
mod tests {
    use super::{COMMANDS, asked_for_help};

    fn args(words: &[&str]) -> Vec<String> {
        words.iter().map(|word| (*word).to_owned()).collect()
    }

    /// Every command main dispatches itself stops at a help flag, wherever it appears, before acting.
    #[test]
    fn a_help_flag_short_circuits_every_command() {
        for command in COMMANDS {
            for words in [&["--help"][..], &["-h"][..], &["--check", "--help"][..], &["--help", "--check"][..]] {
                assert!(asked_for_help(command, &args(words)), "browse {command} {}", words.join(" "));
            }
        }
    }

    /// Tools parse `--help` themselves (cli.rs), and arguments after `--` belong to another program.
    #[test]
    fn tools_keep_their_own_help_and_a_separator_ends_the_scan() {
        for tool in ["navigate", "snapshot", "tabs", "execute", "settings"] {
            assert!(!COMMANDS.contains(&tool), "{tool} is a tool, not a command");
            assert!(!asked_for_help(tool, &args(&["--help"])), "{tool} parses its own --help");
        }
        assert!(!asked_for_help("update", &args(&["--", "--help"])));
        assert!(!asked_for_help("update", &args(&["--check"])));
        assert!(!asked_for_help("install", &args(&["--wait-seconds", "10"])));
        assert!(!asked_for_help("set", &args(&["hostname", "0.0.0.0"])));
        assert!(!asked_for_help("firefox", &args(&["--relaunch", "--app", "zen"])));
    }

    #[test]
    fn firefox_and_disconnect_are_commands_with_help() {
        for command in ["firefox", "disconnect"] {
            assert!(COMMANDS.contains(&command));
            assert!(asked_for_help(command, &args(&["--dedicated", "--help"])), "browse {command} --help");
            assert!(super::HELP.contains(&format!("\n  {command} ")), "{command} is in the help");
        }
        assert!(super::HELP.lines().next().unwrap().contains("Chrome-family"));
        assert!(super::HELP.contains("Firefox-family"));
    }
}
