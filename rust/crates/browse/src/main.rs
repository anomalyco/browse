mod browsers;
mod cli;
mod http;
mod jsonc;
mod legacy;
mod mcp;
mod relay;
mod relay_api;
mod serve;
mod session;
mod setup;
mod update;

pub const VERSION: &str = match option_env!("BROWSE_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};

const HELP: &str = "browse drives your real Chrome-family browser through the browse extension.

SETUP
  install                     Install browse, add it to OpenCode and connect the extension
    --no-open                 Print the steps without opening anything
    --no-wait                 Don't wait for the extension to connect
    --wait-seconds <seconds>  How long to wait (default 180 in a terminal, 90 otherwise)
    --no-modify-path          Don't add browse to PATH
  extension                   Where to get the extension
  pair [--wait-seconds <s>]   Print a one-time pairing code and wait for the browser that redeems it
    --list                    Show paired browsers
    --revoke <browser>        Unpair a browser (its id, name or profile)
  update [--check]            Update now, or only check
    --mode <on|notify|off>    Automatic updates (OPENCODE_BROWSER_AUTO_UPDATE overrides)
  status [--json]             Setup, relay and extension state
  version                     Print the version

RUNNING
  serve                       Run the relay in the foreground (agents start it on demand)
  mcp                         The MCP server OpenCode runs (stdio)
  tools                       List the browser tools
  <tool> [value]... [--arg value]...
                              Call a tool. `browse navigate https://example.com` opens a tab and prints its id
                              (\"tab\"); pass it to the rest: `browse snapshot --tab 12`, `browse click e12 --tab 12`,
                              `browse fill e5 hello --tab 12`, `browse tabs close --tab 12`.
                              Values fill the tool's main options (see `browse <tool> --help`)
    --tab <id>                The tab to act on (from navigate or `browse tabs`)
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
        "--version" | "-v" | "version" => {
            println!("{VERSION}");
            Ok(0)
        }
        "serve" => serve::run(),
        "mcp" => mcp::run().map(|_| 0),
        "install" => setup::install(rest),
        "pair" => setup::pair(rest),
        "extension" => Ok(setup::extension()),
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
