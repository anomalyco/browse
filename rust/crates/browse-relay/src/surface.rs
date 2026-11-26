//! What an MCP client sees, decided here so the MCP proxy only forwards the client's name (CLIENT_HEADER): OpenCode
//! composes plain tools in its own code mode; other clients get `execute` plus `status` and `tabs`.
//! OPENCODE_BROWSER_TOOLS=plain|execute|all overrides it. A caller that names no client (the CLI) gets every tool.

use browse_core::ToolSpec;

const INSTRUCTIONS: &str = include_str!("instructions.md");
const EXECUTE_INSTRUCTIONS: &str = include_str!("instructions-execute.md");
const EXECUTE: &str = "execute";
/// What clients without a code mode see: `execute` for the browser work, and the tools to look around and clean up.
const EXECUTE_SURFACE: &[&str] = &[EXECUTE, "status", "tabs"];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Surface {
    Plain,
    Execute,
    All,
}

/// The surface for a client by its `clientInfo.name`, honoring OPENCODE_BROWSER_TOOLS.
pub fn for_client(client: &str) -> Surface {
    choose(std::env::var("OPENCODE_BROWSER_TOOLS").ok().as_deref(), client)
}

fn choose(choice: Option<&str>, client: &str) -> Surface {
    match choice.map(str::to_ascii_lowercase).as_deref() {
        Some("plain") => return Surface::Plain,
        Some("execute") => return Surface::Execute,
        Some("all") => return Surface::All,
        _ => {}
    }
    // OpenCode sends clientInfo { name: "opencode" }.
    if client.to_ascii_lowercase().contains("opencode") { Surface::Plain } else { Surface::Execute }
}

/// The tools a client sees; `client` None (the CLI, a health check) sees them all.
pub fn tools(client: Option<&str>, specs: Vec<ToolSpec>) -> Vec<ToolSpec> {
    match client.map(for_client).unwrap_or(Surface::All) {
        Surface::All => specs,
        Surface::Plain => specs.into_iter().filter(|s| s.name != EXECUTE).collect(),
        Surface::Execute => EXECUTE_SURFACE.iter().filter_map(|name| specs.iter().find(|s| s.name == *name).cloned()).collect(),
    }
}

/// Leaves out the tools of Labs features that are off (`on` says which are on).
pub fn labs(specs: Vec<ToolSpec>, on: impl Fn(&str) -> bool) -> Vec<ToolSpec> {
    specs.into_iter().filter(|spec| !crate::settings::LABS.contains(&spec.name.as_str()) || on(&spec.name)).collect()
}

/// The MCP server instructions for a client.
pub fn instructions(client: &str) -> &'static str {
    match for_client(client) {
        Surface::Plain => INSTRUCTIONS,
        Surface::Execute | Surface::All => EXECUTE_INSTRUCTIONS,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn spec(name: &str) -> ToolSpec {
        ToolSpec { name: name.into(), description: String::new(), input_schema: json!({}), output_schema: None }
    }

    #[test]
    fn labs_tools_are_listed_only_when_on() {
        let all = || ["navigate", "pdf"].map(spec).to_vec();
        let names = |list: Vec<ToolSpec>| list.into_iter().map(|s| s.name).collect::<Vec<_>>();
        assert_eq!(names(labs(all(), |_| false)), ["navigate"]);
        assert_eq!(names(labs(all(), |lab| lab == "pdf")), ["navigate", "pdf"]);
    }

    #[test]
    fn opencode_gets_plain_tools_and_others_execute() {
        assert_eq!(choose(None, "opencode"), Surface::Plain);
        assert_eq!(choose(None, "OpenCode-desktop"), Surface::Plain);
        assert_eq!(choose(None, "claude-code"), Surface::Execute);
        assert_eq!(choose(None, ""), Surface::Execute);
        assert_eq!(choose(Some("all"), "opencode"), Surface::All);
        assert_eq!(choose(Some("EXECUTE"), "opencode"), Surface::Execute);
        let all = || ["status", "tabs", "navigate", "click", "execute", "settings"].map(spec).to_vec();
        let names = |list: Vec<ToolSpec>| list.into_iter().map(|s| s.name).collect::<Vec<_>>();
        if std::env::var_os("OPENCODE_BROWSER_TOOLS").is_none() {
            assert_eq!(names(tools(Some("opencode"), all())), ["status", "tabs", "navigate", "click", "settings"]);
            assert_eq!(names(tools(Some("claude-code"), all())), ["execute", "status", "tabs"]);
            assert!(instructions("opencode").contains("navigate"));
            assert!(instructions("cursor").contains("execute"));
        }
        assert_eq!(names(tools(None, all())).len(), 6, "the CLI sees every tool");
    }
}
