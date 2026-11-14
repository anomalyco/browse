#!/bin/sh
# Regenerates the vendored page scripts from the TypeScript implementation and Patchright.
#   injected-script.js  Playwright's InjectedScript (Apache-2.0) from cli/node_modules/patchright-core
#   naming.js           cli/src/snapshot/naming.ts, as the browser source the relay used to send
#   capture.js          cli/src/snapshot/browser-capture.ts (embeds naming), the compact snapshot capture
# Run from anywhere: rust/crates/browse-page/js/generate.sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
cli=$(cd "$here/../../../../cli" && pwd)

cd "$cli"
bun -e '
import { browserCapture } from "./src/snapshot/browser-capture.ts"
import { snapshotNamingInBrowser } from "./src/snapshot/naming.ts"
const out = process.argv[1]
const header = (from) => `// Generated from ${from} by js/generate.sh. Do not edit.\n`
await Bun.write(`${out}/capture.js`, header("cli/src/snapshot/browser-capture.ts") + browserCapture.toString().replace(/^function anonymous\(/, "function capture(") + "\n")
await Bun.write(`${out}/naming.js`, header("cli/src/snapshot/naming.ts") + "(" + snapshotNamingInBrowser.toString() + ")\n")
' "$here"

node -e '
const fs = require("fs")
const [bundle, pkg, out] = process.argv.slice(1)
const version = JSON.parse(fs.readFileSync(pkg, "utf8")).version
const lines = fs.readFileSync(bundle, "utf8").split("\n")
const line = lines.find((candidate) => candidate.trim().startsWith("source4 = ")).trim()
const source = eval(line.slice("source4 = ".length, -1))
if (!source.includes("var InjectedScript = class")) throw new Error("injectedScriptSource not found")
if (/sourceURL/.test(source)) throw new Error("injectedScriptSource has a sourceURL marker")
const notice = `/*
 * Playwright InjectedScript, from patchright-core ${version} (packages/playwright-core/src/generated/injectedScriptSource.ts).
 * Vendored by rust/crates/browse-page/js/generate.sh. Do not edit.
 *
 * Copyright (c) Microsoft Corporation. Modifications copyright (c) Patchright contributors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
`
fs.writeFileSync(`${out}/injected-script.js`, notice + source)
' "$cli/node_modules/patchright-core/lib/coreBundle.js" "$cli/node_modules/patchright-core/package.json" "$here"
