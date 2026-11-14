mod browsers;
mod cli;
mod http;
mod jsonc;
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
  <tool> [--arg value]...     Call a tool, e.g. `browse navigate https://example.com`, `browse snapshot`
    --json '<object>'         Arguments as one JSON object
    --session <id>            Session to run in (default: OPENCODE_BROWSER_SESSION, the OpenCode session, or \"cli\")
    --output <path>           Where to save images (default: a temp file, printed)
  <tool> --help               The tool's options
";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
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
