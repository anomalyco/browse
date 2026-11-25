# Agent-facing text

The MCP instructions, tool and parameter descriptions, output schemas, and result and error text in these crates are prompts. Small wording changes move model behavior, so change them carefully:

- Keep them lean, and say what to do in short, direct rules.
- Don't rename parameters or result keys, or drop capabilities, to save space.
- Before merging, A/B the change against `dev` on weak and strong models, with enough runs to see past noise, and report what got worse as well as what got better.
