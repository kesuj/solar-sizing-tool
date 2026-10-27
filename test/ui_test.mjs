// Browser test in headless Edge via the DevTools protocol (no npm deps, Node 22+).
// Usage: serve the folder (py -m http.server 8766) then: node test/ui_test.mjs http://localhost:8766/
// Saves screenshots and a sample PDF report to docs/.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.argv[2] || "http://localhost:8766/";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const OUT = path.resolve(import.meta.dirname, "../docs");
fs.mkdirSync(OUT, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "edge-solar-"));
const edge = spawn(EDGE, ["--headless=new", "--remote-debugging-port=9334", `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws, seq = 0;
const pending = new Map(), events = [], results = [];
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
const js = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result.value;
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`); };
const cards = () => js("[...document.querySelectorAll('.card strong')].map(e => e.textContent)");
async function view(w, h, mobile) { await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile }); await sleep(300); }
async function shot(file) { const { data } = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(OUT, file), Buffer.from(data, "base64")); }

try {
  let target;
  for (let i = 0; i < 40 && !target; i++) {
    try { target = (await (await fetch("http://127.0.0.1:9334/json")).json()).find((t) => t.type === "page"); } catch { await sleep(250); }
  }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result); }
    else if (msg.method) events.push(msg);
  });
  await send("Page.enable"); await send("Runtime.enable");
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await view(1280, 900, false);
  await send("Page.navigate", { url: BASE }); await sleep(1500);

  check("no script errors on load", !events.some((e) => e.method === "Runtime.exceptionThrown"));
  const c = await cards();
  check("clinic example: hand-checked results shown", c[0] === "1 × 550 W" && c[1].startsWith("4 ×") && c[2] === "500 W" && c[3] === "60 A", c.join(" | "));
  await js("window.scrollTo(0, document.getElementById('report').offsetTop - 20)");
  await shot("report-desktop.png");
  await js("window.scrollTo(0, 0)");
  await shot("inputs-desktop.png");

  await js("{ const s=document.getElementById('chem'); s.value='pb'; s.dispatchEvent(new Event('change')) }");
  const pb = await cards();
  check("lead-acid needs a bigger battery bank", parseInt(pb[1]) > 4, pb[1]);
  await js("{ const s=document.getElementById('chem'); s.value='lfp'; s.dispatchEvent(new Event('change')) }");

  await js("{ const s=document.getElementById('preset'); s.value='shop'; s.dispatchEvent(new Event('change')) }");
  const rowsShop = await js("document.querySelectorAll('#load-rows tr').length");
  await js("document.getElementById('add-load').click()");
  await js(`(() => { const r = document.querySelector('#load-rows tr:last-child');
    const set = (k, v) => { const el = r.querySelector('[data-k=' + k + ']'); el.value = v; el.dispatchEvent(new Event('input', {bubbles:true})); };
    set('name', 'Water pump'); set('watts', 750); set('hoursPerDay', 2); set('surgeFactor', 3); })()`);
  const shop = await js("window.__lastResult");
  check("adding a 750 W pump moves the shop to 48 V (5,491 Wh/day by hand)", rowsShop === 4 && shop.system.nominalVolts === 48 && shop.inverter.ratingW >= 1500,
    `rows before add ${rowsShop}, ${shop.system.nominalVolts} V, inverter ${shop.inverter.ratingW} W, warnings: ${shop.warnings.length}`);

  await js("document.getElementById('project').value='Shop test'; document.getElementById('project').dispatchEvent(new Event('input'))");
  await js("document.getElementById('share').click()"); await sleep(300);
  const url = await js("location.href");
  await send("Page.navigate", { url: "about:blank" }); await sleep(300);
  await send("Page.navigate", { url }); await sleep(1500);
  const restored = await js("({ p: document.getElementById('project').value, n: document.querySelectorAll('#load-rows tr').length })");
  check("shareable link restores the project", restored.p === "Shop test" && restored.n === 5, JSON.stringify(restored));

  await js(`(() => { const el = document.querySelector('#load-rows tr [data-k=hoursPerDay]'); el.value = 30; el.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  check("invalid hours show an error, not numbers", /cannot exceed 24/.test(await js("document.getElementById('report').textContent")));

  await send("Page.navigate", { url: BASE }); await sleep(1500);
  await view(390, 844, true);
  check("mobile: no horizontal page scroll", await js("document.documentElement.scrollWidth <= window.innerWidth"));
  await shot("inputs-mobile.png");

  await view(1280, 900, false);
  await js("document.getElementById('client').value='Sample client (demo)'; document.getElementById('client').dispatchEvent(new Event('input'))");
  const pdf = await send("Page.printToPDF", { printBackground: false, paperWidth: 8.27, paperHeight: 11.69, marginTop: 0.5, marginBottom: 0.5, marginLeft: 0.5, marginRight: 0.5 });
  fs.writeFileSync(path.join(OUT, "sample-report.pdf"), Buffer.from(pdf.data, "base64"));
  check("print view produces a PDF report", fs.statSync(path.join(OUT, "sample-report.pdf")).size > 20000);
} catch (e) {
  check("test run", false, e.stack);
} finally {
  try { ws?.close(); } catch {}
  edge.kill();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed. Output in ${OUT}`);
  process.exitCode = failed ? 1 : 0;
}
