//! The agent picker `browse install` shows in a terminal (cli/src/setup/agent-picker.ts): OpenCode first, then the
//! agents found on this computer, ticked as the last install left them; typing searches every agent install knows.

use std::io::Write;

use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use crossterm::terminal;

pub struct Choice {
    pub name: &'static str,
    pub label: &'static str,
    pub installed: bool,
}

const DIM: &str = "\x1b[2m";
const CYAN: &str = "\x1b[36m";
const GREEN: &str = "\x1b[32m";
const YELLOW: &str = "\x1b[33m";
const RESET: &str = "\x1b[0m";
const ROWS: usize = 10;
const QUESTION: &str = "Set browse up in these agents?";

/// Whether every letter of `query` appears in `text` in order.
fn fuzzy(query: &str, text: &str) -> bool {
    let mut wanted = query.chars().peekable();
    for c in text.to_lowercase().chars() {
        if wanted.peek() == Some(&c) {
            wanted.next();
        }
    }
    wanted.peek().is_none()
}

struct Picker<'a> {
    choices: &'a [Choice],
    selected: Vec<&'static str>,
    query: String,
    cursor: usize,
    navigating: bool,
    drawn: u16,
}

impl Picker<'_> {
    fn shown(&self) -> Vec<&Choice> {
        let query = self.query.trim().to_lowercase();
        self.choices
            .iter()
            .filter(|c| if query.is_empty() { c.installed || self.selected.contains(&c.name) || c.name == "opencode" } else { fuzzy(&query, c.label) || fuzzy(&query, c.name) })
            .collect()
    }

    fn toggle(&mut self) {
        let Some(choice) = self.shown().get(self.cursor).map(|c| c.name) else { return };
        match self.selected.iter().position(|n| *n == choice) {
            Some(i) => {
                self.selected.remove(i);
            }
            None => self.selected.push(choice),
        }
    }

    fn render(&mut self, out: &mut impl Write) -> std::io::Result<()> {
        let len = self.shown().len();
        self.cursor = self.cursor.min(len.saturating_sub(1));
        let shown = self.shown();
        let mut lines = vec![format!("{CYAN}◆{RESET}  {QUESTION}")];
        let count = if self.query.is_empty() { String::new() } else { format!(" {DIM}({} match{}){RESET}", shown.len(), if shown.len() == 1 { "" } else { "es" }) };
        lines.push(format!("{CYAN}│{RESET}  {DIM}Search:{RESET} {}{count}", self.query));
        if shown.is_empty() {
            lines.push(format!("{CYAN}│{RESET}  {YELLOW}No matches found{RESET}"));
        }
        let first = self.cursor.saturating_sub(ROWS - 1).min(shown.len().saturating_sub(ROWS));
        for (i, choice) in shown.iter().enumerate().skip(first).take(ROWS) {
            let ticked = self.selected.contains(&choice.name);
            let box_ = if ticked { format!("{GREEN}◼{RESET}") } else { format!("{DIM}◻{RESET}") };
            let row = if i == self.cursor { format!("{CYAN}❯{RESET} {box_} {}", choice.label) } else { format!("  {box_} {DIM}{}{RESET}", choice.label) };
            lines.push(format!("{CYAN}│{RESET}  {row}"));
        }
        let select = if self.navigating || self.query.is_empty() { "Space/Tab:" } else { "Tab:" };
        lines.push(format!("{CYAN}│{RESET}  {DIM}↑/↓{RESET} to navigate • {DIM}{select}{RESET} select • {DIM}Enter:{RESET} confirm • {DIM}Type:{RESET} to search"));
        lines.push(format!("{CYAN}└{RESET}"));
        self.redraw(out, &lines)
    }

    fn redraw(&mut self, out: &mut impl Write, lines: &[String]) -> std::io::Result<()> {
        if self.drawn > 0 {
            write!(out, "\x1b[{}A", self.drawn)?;
        }
        write!(out, "\r\x1b[J{}\r\n", lines.join("\r\n"))?;
        self.drawn = lines.len() as u16;
        out.flush()
    }
}

/// Lets the user pick agents, starting from `initial`. None when they cancel (Esc or Ctrl+C).
pub fn pick(choices: &[Choice], initial: &[&'static str]) -> anyhow::Result<Option<Vec<&'static str>>> {
    let mut picker = Picker { choices, selected: initial.to_vec(), query: String::new(), cursor: 0, navigating: false, drawn: 0 };
    let mut out = std::io::stdout();
    terminal::enable_raw_mode()?;
    let result = (|| -> anyhow::Result<Option<bool>> {
        write!(out, "\x1b[?25l")?;
        picker.render(&mut out)?;
        loop {
            let Event::Key(KeyEvent { code, modifiers, kind, .. }) = event::read()? else { continue };
            if kind == KeyEventKind::Release {
                continue;
            }
            match code {
                KeyCode::Char('c') if modifiers.contains(KeyModifiers::CONTROL) => return Ok(None),
                KeyCode::Esc => return Ok(None),
                KeyCode::Enter => return Ok(Some(true)),
                KeyCode::Up => {
                    picker.navigating = true;
                    let len = picker.shown().len().max(1);
                    picker.cursor = (picker.cursor + len - 1) % len;
                }
                KeyCode::Down => {
                    picker.navigating = true;
                    picker.cursor = (picker.cursor + 1) % picker.shown().len().max(1);
                }
                KeyCode::Tab => picker.toggle(),
                KeyCode::Char(' ') if picker.navigating || picker.query.is_empty() => picker.toggle(),
                KeyCode::Backspace => {
                    picker.navigating = false;
                    picker.query.pop();
                    picker.cursor = 0;
                }
                KeyCode::Char(c) if !modifiers.contains(KeyModifiers::CONTROL) => {
                    picker.navigating = false;
                    picker.query.push(c);
                    picker.cursor = 0;
                }
                _ => {}
            }
            picker.render(&mut out)?;
        }
    })();
    let summary = match &result {
        Ok(Some(_)) => {
            let names: Vec<&str> = choices.iter().filter(|c| picker.selected.contains(&c.name)).map(|c| c.label).collect();
            format!("{GREEN}◇{RESET}  {QUESTION}\r\n│  {DIM}{}{RESET}", if names.is_empty() { "none".into() } else { names.join(", ") })
        }
        _ => format!("{YELLOW}■{RESET}  {QUESTION}\r\n│  {DIM}cancelled{RESET}"),
    };
    let _ = picker.redraw(&mut out, &[summary]);
    let _ = write!(out, "\x1b[?25h");
    let _ = out.flush();
    terminal::disable_raw_mode()?;
    Ok(result?.map(|_| choices.iter().map(|c| c.name).filter(|n| picker.selected.contains(n)).collect()))
}

#[cfg(test)]
mod tests {
    #[test]
    fn fuzzy_search() {
        assert!(super::fuzzy("cc", "Claude Code"));
        assert!(super::fuzzy("cdx", "codex"));
        assert!(!super::fuzzy("zz", "Claude Code"));
    }
}
