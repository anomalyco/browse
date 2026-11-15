// A Playwright script written for the TypeScript execute: read an SVG hit counter, with dead-tab recovery.

const URL = "https://count.example.com/get/@counter?padding=7";

async function readDigits() {
  return page.evaluate(() => {
    const uses = Array.from(document.querySelectorAll("use"))
      .map((u) => ({
        x: parseFloat(u.getAttribute("x") || "0"),
        ref: (u.getAttribute("href") || u.getAttribute("xlink:href") || "").replace(/^#/, ""),
      }))
      .sort((a, b) => a.x - b.x)
      .map((u) => u.ref);
    return {
      uses,
      ids: Array.from(document.querySelectorAll("image")).map((n) => n.getAttribute("id")),
    };
  });
}

async function dropOtherTabs(keep) {}

const DEAD_TAB = /has been closed|Target closed|crash|Detached while handling command|Protocol error \(Page\./i;
for (let attempt = 0; ; attempt++) {
  try {
    await page.goto(URL, { waitUntil: "load" });
    break;
  } catch (e) {
    if (attempt >= 2 || !DEAD_TAB.test(String(e.message))) throw e;
    try { page = await page.context().newPage(); } catch (ignored) {
      try { await page.waitForTimeout(1500); } catch (ignored2) {}
      page = await page.context().newPage();
    }
    await dropOtherTabs(page);
  }
}
let read = { uses: [], ids: [] };
const deadline = Date.now() + 25000;
while (Date.now() < deadline) {
  read = await readDigits();
  if (read.uses.length >= 7 && read.uses.every((d) => /^\d$/.test(d))) break;
  await page.waitForTimeout(500);
}

const digits = read.uses.every((d) => /^\d$/.test(d)) ? read.uses.join("") : "";
return JSON.stringify({
  digits,
  uses: read.uses,
  ids: read.ids,
  value: digits.length >= 7 ? Number(digits) : null,
});
