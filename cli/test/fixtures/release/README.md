# Release protocol test vectors

`decisions.json` and `manifests.json` are copied from
[`anomalyco/release`](https://github.com/anomalyco/release) `test-vectors/` (2026-11-07). They are the service's client
decision vectors: every client must reproduce `src/protocol/decide.ts`, and `test/release-vectors.test.ts` runs all of
them against `cli/src/update/release-service.ts`.

When the release repo changes the rules or the vectors (`bun run vectors` there), copy both files here in the same
change. `semver.json` is not needed: clients never order versions.
