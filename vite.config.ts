import { defineConfig } from "vite"
import solid from "vite-plugin-solid"
import { fileURLToPath } from "node:url"

// The extension is loaded unpacked from dist/. The service worker must keep a stable name for the
// manifest; everything else is content-hashed.
export default defineConfig(({ mode }) => ({
  // Identifies this build in the relay's log and status, so install can tell whether a reload took effect. The CLI's
  // build passes its own stamp so it can record it next to the copied extension.
  // OPENCODE_BROWSER_TEST_HOOKS=1 builds the stress harness's hooks in (src/background/index.ts); without it they're
  // compiled out, so a release never carries them.
  define: {
    __OPENCODE_BROWSER_BUILD__: JSON.stringify(process.env.OPENCODE_BROWSER_BUILD ?? new Date().toISOString()),
    __OPENCODE_BROWSER_TEST_HOOKS__: JSON.stringify(process.env.OPENCODE_BROWSER_TEST_HOOKS === "1"),
  },
  // The onboarding and settings pages are Solid, with @opencode/ui; everything they use is bundled (MV3 runs no
  // remote code).
  plugins: [solid()],
  root: fileURLToPath(new URL(".", import.meta.url)),
  publicDir: "public",
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome130",
    minify: mode !== "development",
    sourcemap: mode === "development" ? "inline" : false,
    modulePreload: false,
    rolldownOptions: {
      input: {
        welcome: fileURLToPath(new URL("./welcome.html", import.meta.url)),
        onboarding: fileURLToPath(new URL("./onboarding.html", import.meta.url)),
        settings: fileURLToPath(new URL("./settings.html", import.meta.url)),
        offscreen: fileURLToPath(new URL("./offscreen.html", import.meta.url)),
        background: fileURLToPath(new URL("./src/background/index.ts", import.meta.url)),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js"),
      },
    },
  },
}))
