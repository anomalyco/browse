# Agent-facing text

Agents read Browse's MCP instructions (`rust/crates/browse-relay/src/instructions*.md`), tool and parameter descriptions, output schemas, and the text of results and errors. Small wording changes move model behavior, so treat this text like code without a type checker.

- Keep it lean. Every request carries the instructions, and clients without code mode carry every tool definition too. Cut words that don't change what a model does, and leave self-explanatory parameters (`url`, `x`, `y`) without a description.
- Write rules, not prose: short, direct sentences that say what to do and what not to do. Compressed prose has made models skip steps (closing their tabs) where the same facts as one-line rules didn't.
- Make each tool stand on its own. Tool search shows one tool at a time, so don't point at another tool's docs ("as in navigate"). Shared concepts (tabs, refs) belong in the instructions; shared parameters get the same short phrase on every tool.
- Don't rename parameters or result keys that models already guess. Renaming `eval`'s `expression` to `code` made wrong-name calls about 6x more common.
- Don't drop a parameter or capability to save space. Describe it more briefly instead.

## Measure before you merge

Every change to this text needs an A/B against `dev`, with the results in the PR:

- Weak and strong models: at least a small Anthropic, a small OpenAI and a DeepSeek Flash model, plus one strong model. Weak models regress first.
- Enough runs to see past noise: pass rates move by about 3 in 96 between identical runs. Use at least 4 reps per task, and rerun a cell that looks off before deciding.
- Compare more than pass rate: steps, cost, failed and retried calls, wrong parameter names, and cleanup (tabs closed at the end).
- Change one thing at a time, or ablate a bundle to find which part moved the numbers.
- Report what got worse, not only what got better.
