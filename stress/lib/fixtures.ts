// The local fixture site the scenarios drive. One server on 127.0.0.1:<port>; http://localhost:<port> is a second
// origin (and site) for cross-origin iframes. Loopback only, so exe.dev's proxy never exposes it.
import http from "node:http"
import path from "node:path"
import { createRequire } from "node:module"
import { repo } from "./env.ts"


const page = (title: string, body: string, head = "") =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`

// A one-page PDF with the text "Stress PDF".
function pdf(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "<< /Length 44 >>\nstream\nBT /F1 24 Tf 40 100 Td (Stress PDF) Tj ET\nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  let out = "%PDF-1.4\n"
  const offsets: number[] = []
  objects.forEach((object, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${object}\nendobj\n` })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, "latin1")
}

export type Fixtures = { url: (p: string) => string; crossUrl: (p: string) => string; wsUrl: string; hits: Map<string, number>; close: () => Promise<void> }

export async function startFixtures(port: number): Promise<Fixtures> {
  const { WebSocketServer } = createRequire(path.join(repo, "cli/package.json"))("ws") as typeof import("ws")
  const hits = new Map<string, number>()
  const cross = `http://localhost:${port}`
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`)
    hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1)
    const html = (body: string, status = 200, headers: Record<string, string> = {}) => {
      response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers })
      response.end(body)
    }
    const p = url.pathname
    if (p === "/" || p === "/index") return html(page("Fixture index", `<h1>Fixtures</h1><ul>${["form", "popup", "iframe-same", "iframe-cross", "shadow", "dialogs", "upload", "download", "doc.pdf", "sw", "ws", "h/1", "long", "big", "network"].map((x) => `<li><a href="/${x}">${x}</a></li>`).join("")}</ul>`))
    if (p === "/form") return html(page("Form", `<label>Name<input id="name"></label><button onclick="document.querySelector('output').textContent=document.querySelector('#name').value">Save</button><output></output>`))
    if (p === "/popup") return html(page("Popup", `<a id="blank" href="/target?from=blank" target="_blank">Open blank</a><button id="open" onclick="window.open('/target?from=open','_blank','popup,width=500,height=400')">Open window</button>`))
    if (p === "/target") return html(page("Target", `<h1>Target ${url.searchParams.get("from") ?? ""}</h1>`))
    if (p === "/iframe-same") return html(page("Same-origin iframe", `<h1>Parent</h1><iframe id="f" src="/frame-child" width="400" height="200"></iframe>`))
    if (p === "/iframe-cross") return html(page("Cross-origin iframe", `<h1>Parent</h1><iframe id="f" src="${cross}/frame-child" width="400" height="200"></iframe>`))
    if (p === "/frame-child") return html(page("Child", `<p id="origin"></p><button onclick="this.textContent='pressed'">Press</button><script>document.getElementById('origin').textContent=location.origin</script>`))
    if (p === "/shadow") return html(page("Shadow DOM", `<x-card></x-card><script>
      customElements.define('x-card', class extends HTMLElement { connectedCallback() {
        const root = this.attachShadow({ mode: 'open' })
        root.innerHTML = '<label>Inner<input id="inner"></label><button id="b">Shadow button</button><span id="s"></span>'
        root.getElementById('b').onclick = () => { root.getElementById('s').textContent = 'shadow:' + root.getElementById('inner').value }
      }})</script>`))
    if (p === "/dialogs") return html(page("Dialogs", `<button id="alert" onclick="alert('hello');document.title='alerted'">Alert</button>
      <button id="confirm" onclick="document.title='confirm:'+confirm('sure?')">Confirm</button>
      <button id="prompt" onclick="document.title='prompt:'+prompt('name?','x')">Prompt</button>`))
    if (p === "/beforeunload") return html(page("Beforeunload", `<button onclick="this.textContent='armed'">Arm</button><script>addEventListener('beforeunload', e => { e.preventDefault(); e.returnValue = '' })</script>`))
    if (p === "/upload") return html(page("Upload", `<input type="file" id="file" onchange="const f=this.files[0];document.getElementById('out').textContent=f.name+':'+f.size"><span id="out"></span>`))
    if (p === "/download") return html(page("Download", `<a id="dl" href="/file.txt">Download file</a>`))
    if (p === "/file.txt") { response.writeHead(200, { "content-type": "text/plain", "content-disposition": "attachment; filename=stress.txt" }); return response.end("stress download\n") }
    if (p === "/doc.pdf") { response.writeHead(200, { "content-type": "application/pdf" }); return response.end(pdf()) }
    if (p === "/sw") return html(page("Service worker", `<p id="state">registering</p><script>
      navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).then(() => { document.getElementById('state').textContent = 'ready' })</script>`))
    if (p === "/sw.js") { response.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" }); return response.end(`self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('activate', e => e.waitUntil(clients.claim())); self.addEventListener('fetch', e => { if (new URL(e.request.url).pathname === '/sw-hello') e.respondWith(new Response('from-sw')) })`) }
    if (p === "/sw-hello") { response.writeHead(200, { "content-type": "text/plain" }); return response.end("from-network") }
    if (p === "/ws") return html(page("WebSocket", `<p id="ws">connecting</p><script>
      const s = new WebSocket('ws://127.0.0.1:${port}/echo'); s.onopen = () => s.send('ping'); s.onmessage = e => { document.getElementById('ws').textContent = 'got:' + e.data }</script>`))
    if (/^\/h\/\d+$/.test(p)) return html(page(`History ${p.slice(3)}`, `<h1>History ${p.slice(3)}</h1><a href="/h/${Number(p.slice(3)) + 1}">next</a>`))
    if (p === "/long") return html(page("Long", `<div style="height:20000px;background:linear-gradient(#fff,#ccd)">top</div><button id="bottom" onclick="this.textContent='reached'">Bottom</button>`))
    if (p === "/big") return html(page("Big DOM", `<table>${Array.from({ length: 5000 }, (_, i) => `<tr><td>Row ${i}</td><td><a href="#r${i}">link ${i}</a></td><td><button>Act ${i}</button></td></tr>`).join("")}</table>`))
    if (p === "/slow") { await new Promise((r) => setTimeout(r, Math.min(Number(url.searchParams.get("ms")) || 3000, 60_000))); return html(page("Slow", `<h1>Slow done</h1>`)) }
    if (p === "/redirect") { const n = Number(url.searchParams.get("n")) || 0; response.writeHead(302, { location: n > 1 ? `/redirect?n=${n - 1}` : "/target?from=redirect" }); return response.end() }
    if (p.startsWith("/status/")) return html(page(`Status ${p.slice(8)}`, `<h1>Status ${p.slice(8)}</h1>`), Number(p.slice(8)) || 500)
    if (p === "/network") return html(page("Network", `<ul id="out"></ul><script>
      Promise.all([1,2,3].map(i => fetch('/api/data?i=' + i, { headers: { authorization: 'Bearer stress-fake-token-' + i } }).then(r => r.json()))).then(rows => { document.getElementById('out').textContent = rows.length + ' rows' })</script>`))
    if (p === "/api/data") { response.writeHead(200, { "content-type": "application/json", "set-cookie": "stress=1; Path=/" }); return response.end(JSON.stringify({ ok: true, i: url.searchParams.get("i") })) }
    if (p === "/animate") return html(page("Animate", `<div id="box" style="width:120px;height:120px;background:#4c8dff;animation:spin 1s linear infinite"></div><style>@keyframes spin{to{transform:rotate(360deg) translateX(200px)}}</style><p id="t"></p><script>setInterval(()=>{document.getElementById('t').textContent=Date.now()},50)</script>`))
    if (p === "/cookie") return html(page("Cookie", `<p>cookie set</p>`), 200, { "set-cookie": "fixture=yes; Path=/" })
    if (p === "/handoff") return html(page("Handoff", `<h1>Sign in</h1><p>Pretend a 2FA prompt is here.</p>`))
    if (p === "/many-frames") return html(page("Many frames", Array.from({ length: 20 }, (_, i) => `<iframe src="${i % 2 ? cross : ""}/frame-child?i=${i}" width="200" height="80"></iframe>`).join("")))
    if (p === "/heavy") return html(page("Heavy", `<p id="n"></p><script>let n=0;const t=Date.now();while(Date.now()-t<1500){n++};document.getElementById('n').textContent=n</script>`))
    html(page("Not found", "<h1>404</h1>"), 404)
  })
  const wss = new WebSocketServer({ noServer: true })
  server.on("upgrade", (request, socket, head) => {
    if (!request.url?.startsWith("/echo")) return socket.destroy()
    wss.handleUpgrade(request, socket, head, (ws) => ws.on("message", (data) => ws.send(String(data))))
  })
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve) })
  return {
    url: (p) => `http://127.0.0.1:${port}${p}`,
    crossUrl: (p) => `${cross}${p}`,
    wsUrl: `ws://127.0.0.1:${port}/echo`,
    hits,
    close: () => new Promise((resolve) => { wss.close(); server.closeAllConnections(); server.close(() => resolve()) }),
  }
}
