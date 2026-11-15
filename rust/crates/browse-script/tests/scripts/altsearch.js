// A Playwright script written for the TypeScript execute (an hourly people-search monitor), with neutral names.

const HANDLES = ["suspended_one", "missing_one", "protected_one", "broken_one", "acme_dev", "acme_team"];
const QUERIES = ["示例", "例子", "Example", "example", "Acme", "acmecat", '"an exact phrase"', "ExactPhrase"];

const out = { at: new Date().toISOString(), status: {}, users: [], errors: [] };

for (const h of HANDLES) {
  try {
    await page.goto(`https://x.com/${h}`, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(5000);
    const text = await page.evaluate(() => document.body.innerText);
    out.status[h] = /Account suspended/.test(text) ? "suspended"
      : /This account doesn.t exist/.test(text) ? "missing"
      : /These posts are protected/.test(text) ? "protected"
      : /Something went wrong|Try reloading/.test(text) ? "error"
      : "visible";
  } catch (e) {
    out.status[h] = "error";
    out.errors.push(`${h}: ${String(e.message).slice(0, 120)}`);
  }
}

for (const q of QUERIES) {
  try {
    await page.goto("https://x.com/search?q=" + encodeURIComponent(q) + "&f=user", {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    await page.waitForTimeout(5000);
    await page.mouse.wheel(0, 2000);
    await page.waitForTimeout(1500);
    const cells = await page.$$eval('[data-testid="UserCell"]', (cs) =>
      cs.map((c) => {
        const links = [...c.querySelectorAll('a[href^="/"]')].map((a) => a.getAttribute("href"));
        const handle = (links.find((l) => /^\/[A-Za-z0-9_]{1,15}$/.test(l)) || "").slice(1);
        return { handle, text: c.innerText.replace(/\s+/g, " ").slice(0, 400) };
      }),
    );
    for (const cell of cells) if (cell.handle) out.users.push({ query: q, ...cell });
  } catch (e) {
    out.errors.push(`${q}: ${String(e.message).slice(0, 120)}`);
  }
}

return JSON.stringify(out);
