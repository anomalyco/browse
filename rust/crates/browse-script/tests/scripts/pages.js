// A Playwright script written for the TypeScript execute: read pages' text.
let out = { pages: [] };
try {
  const targets = JSON.parse(process.env.OC_TARGETS || "[]");
  for (const t of targets) {
    try {
      await page.goto(t, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(3000);
      const r = await page.evaluate(() => ({
        url: location.href,
        text: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 60000),
      }));
      out.pages.push(r);
    } catch (e) {
      out.pages.push({ url: t, text: "", error: e.message });
    }
  }
} catch (e) { out.error = e.message; }
return JSON.stringify(out);
