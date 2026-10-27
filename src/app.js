import { size, DEFAULTS } from "./engine.js";

const PRESETS = {
  clinic: [
    { name: "LED light", watts: 10, qty: 5, hoursPerDay: 6 },
    { name: "Vaccine fridge", watts: 100, qty: 1, hoursPerDay: 10, surgeFactor: 5 },
    { name: "Laptop", watts: 65, qty: 1, hoursPerDay: 4 },
  ],
  home: [
    { name: "LED light", watts: 9, qty: 6, hoursPerDay: 5 },
    { name: "LED TV", watts: 60, qty: 1, hoursPerDay: 4 },
    { name: "Ceiling fan", watts: 60, qty: 2, hoursPerDay: 6, surgeFactor: 2 },
    { name: "Phone charging (DC)", watts: 10, qty: 3, hoursPerDay: 2, dc: true },
  ],
  shop: [
    { name: "LED tube", watts: 18, qty: 6, hoursPerDay: 8 },
    { name: "Chest freezer", watts: 150, qty: 1, hoursPerDay: 12, surgeFactor: 5 },
    { name: "POS + printer", watts: 60, qty: 1, hoursPerDay: 10 },
    { name: "Wi-Fi router", watts: 12, qty: 1, hoursPerDay: 24 },
  ],
  blank: [{ name: "", watts: 0, qty: 1, hoursPerDay: 0 }],
};
const CHEM = { lfp: { depthOfDischarge: 0.8, batteryEfficiency: 0.95 }, pb: { depthOfDischarge: 0.5, batteryEfficiency: 0.85 } };

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n, d = 0) => Number(n).toLocaleString("en-US", { maximumFractionDigits: d });

let state = { project: "Off-grid health post", client: "", loads: structuredClone(PRESETS.clinic), opts: { ...DEFAULTS } };

// ---------- state <-> URL (shareable link) ----------
function loadFromHash() {
  if (!location.hash.startsWith("#s=")) return;
  try {
    const s = JSON.parse(decodeURIComponent(escape(atob(location.hash.slice(3)))));
    if (Array.isArray(s.loads)) state = { ...state, ...s, opts: { ...DEFAULTS, ...s.opts } };
  } catch { /* ignore a malformed link and keep defaults */ }
}
const shareUrl = () => location.href.split("#")[0] + "#s=" + btoa(unescape(encodeURIComponent(JSON.stringify(state))));

// ---------- inputs ----------
function renderLoads() {
  $("#load-rows").innerHTML = state.loads.map((l, i) => `<tr data-i="${i}">
    <td><input aria-label="Appliance" data-k="name" value="${esc(l.name)}"></td>
    <td><input aria-label="Watts" type="number" min="0" data-k="watts" value="${l.watts}"></td>
    <td><input aria-label="Quantity" type="number" min="0" data-k="qty" value="${l.qty}"></td>
    <td><input aria-label="Hours per day" type="number" min="0" max="24" step="0.5" data-k="hoursPerDay" value="${l.hoursPerDay}"></td>
    <td><input aria-label="Surge multiple" type="number" min="1" step="0.5" data-k="surgeFactor" value="${l.surgeFactor || 1}"></td>
    <td><input aria-label="DC load" type="checkbox" data-k="dc" ${l.dc ? "checked" : ""}></td>
    <td class="num" data-wh></td>
    <td><button type="button" class="x" aria-label="Remove ${esc(l.name || "load")}">✕</button></td></tr>`).join("");
}
function syncOptInputs() {
  document.querySelectorAll("[data-opt]").forEach((el) => { el.value = state.opts[el.dataset.opt]; });
  const o = state.opts;
  $("#chem").value = Object.keys(CHEM).find((k) => CHEM[k].depthOfDischarge === o.depthOfDischarge && CHEM[k].batteryEfficiency === o.batteryEfficiency) || "custom";
  $("#project").value = state.project;
  $("#client").value = state.client;
}

$("#load-rows").addEventListener("input", (e) => {
  const tr = e.target.closest("tr"); const k = e.target.dataset.k;
  if (!tr || !k) return;
  const l = state.loads[tr.dataset.i];
  l[k] = k === "name" ? e.target.value : k === "dc" ? e.target.checked : Number(e.target.value);
  update();
});
$("#load-rows").addEventListener("click", (e) => {
  if (!e.target.classList.contains("x")) return;
  state.loads.splice(e.target.closest("tr").dataset.i, 1);
  if (!state.loads.length) state.loads.push(structuredClone(PRESETS.blank[0]));
  renderLoads(); update();
});
$("#add-load").addEventListener("click", () => {
  state.loads.push({ name: "", watts: 0, qty: 1, hoursPerDay: 0 });
  renderLoads(); update();
  $("#load-rows tr:last-child input").focus();
});
$("#preset").addEventListener("change", (e) => { state.loads = structuredClone(PRESETS[e.target.value]); renderLoads(); update(); });
document.querySelectorAll("[data-opt]").forEach((el) => el.addEventListener("input", () => {
  const k = el.dataset.opt;
  state.opts[k] = k === "systemVolts" && el.value === "auto" ? "auto" : Number(el.value);
  if (k === "depthOfDischarge" || k === "batteryEfficiency") $("#chem").value = "custom";
  update();
}));
$("#chem").addEventListener("change", (e) => { if (CHEM[e.target.value]) { Object.assign(state.opts, CHEM[e.target.value]); syncOptInputs(); update(); } });
$("#project").addEventListener("input", (e) => { state.project = e.target.value; update(); });
$("#client").addEventListener("input", (e) => { state.client = e.target.value; update(); });

// ---------- output ----------
// Simple single-line diagram: PV -> MPPT -> battery -> inverter -> AC loads, with cables and protection.
function sld(r) {
  const o = r.inputs, inv = r.inverter, c1 = r.cables.batteryToInverter, c2 = r.cables.controllerToBattery;
  const blocks = [
    ["PV array", `${r.pv.panels} × ${o.panelWatts} W`, `${fmt(r.pv.arrayW)} W`],
    ["MPPT controller", r.controller.ratingA ? `${r.controller.ratingA} A` : "split array", `${r.system.nominalVolts} V battery`],
    ["Battery bank", `${r.battery.series}S${r.battery.parallel}P`, `${r.battery.bankAh} Ah · ${fmt(r.battery.bankWh / 1000, 1)} kWh`],
  ];
  if (inv) blocks.push(["Inverter", inv.ratingW ? `${fmt(inv.ratingW)} W` : "too large", "pure sine"], ["AC loads", `${fmt(inv.continuousW)} W`, `${o.acVolts} V AC`]);
  const links = [
    ["DC isolator", "string fuses per datasheet"],
    [c2.fuseA ? `${c2.fuseA} A DC fuse` : "fuse: n/a", c2.areaMm2 ? `${c2.areaMm2} mm² Cu, ${o.cableControllerBatteryM} m` : "cable: n/a"],
  ];
  if (inv) links.push(
    [c1?.fuseA ? `${c1.fuseA} A DC fuse` : "fuse: n/a", c1?.areaMm2 ? `${c1.areaMm2} mm² Cu, ${o.cableBatteryInverterM} m` : "cable: n/a"],
    [inv.acBreakerA ? `${inv.acBreakerA} A MCB` : "MCB: n/a", "AC distribution"]);
  const bw = 132, gap = 58, h = 74, y = 34, W = blocks.length * bw + (blocks.length - 1) * gap + 20;
  let svg = "";
  blocks.forEach(([t, a, b], i) => {
    const x = 10 + i * (bw + gap);
    svg += `<rect x="${x}" y="${y}" width="${bw}" height="${h}" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
      <text x="${x + bw / 2}" y="${y + 22}" text-anchor="middle" font-weight="700">${esc(t)}</text>
      <text x="${x + bw / 2}" y="${y + 42}" text-anchor="middle">${esc(a)}</text>
      <text x="${x + bw / 2}" y="${y + 60}" text-anchor="middle" opacity=".7">${esc(b)}</text>`;
    if (i < links.length) {
      const x1 = x + bw, x2 = x1 + gap, ym = y + h / 2;
      svg += `<line x1="${x1}" y1="${ym}" x2="${x2}" y2="${ym}" stroke="currentColor" stroke-width="2"/>
        <rect x="${x1 + gap / 2 - 9}" y="${ym - 5}" width="18" height="10" fill="var(--bg)" stroke="currentColor"/>
        <text x="${x1 + gap / 2}" y="${y - 10}" text-anchor="middle" font-size="10.5">${esc(links[i][0])}</text>
        <text x="${x1 + gap / 2}" y="${y + h + 22}" text-anchor="middle" font-size="10.5" opacity=".8">${esc(links[i][1])}</text>`;
    }
  });
  return `<div class="table-scroll"><svg class="sld" viewBox="0 0 ${W} ${y + h + 40}" width="${W}" role="img"
    aria-label="Single-line diagram from PV array to loads" font-family="system-ui, sans-serif" font-size="12" fill="currentColor">${svg}</svg></div>`;
}

const row = (label, value, how = "") => `<tr><th scope="row">${label}</th><td class="num">${value}</td><td class="how">${how}</td></tr>`;

function renderReport(r) {
  const o = r.inputs;
  const used = state.loads.filter((l) => l.watts > 0 && l.qty > 0 && l.hoursPerDay > 0);
  const inv = r.inverter;
  const c1 = r.cables.batteryToInverter, c2 = r.cables.controllerToBattery;
  const cableTxt = (c) => c.areaMm2 ? `${c.areaMm2} mm² copper` : "none up to 120 mm²";
  return `
  <div class="report-head"><h2>${esc(state.project || "Solar sizing report")}</h2>
  <p class="muted">${state.client ? "Prepared for " + esc(state.client) + " · " : ""}${new Date().toISOString().slice(0, 10)} · ${r.system.nominalVolts} V system</p></div>

  <div class="cards">
    <div class="card"><span>Solar array</span><strong>${r.pv.panels} × ${o.panelWatts} W</strong><em>${fmt(r.pv.arrayW)} W total</em></div>
    <div class="card"><span>Battery bank</span><strong>${r.battery.units} × ${o.batteryUnitVolts} V ${o.batteryUnitAh} Ah</strong><em>${r.battery.series}S${r.battery.parallel}P · ${fmt(r.battery.bankWh / 1000, 1)} kWh</em></div>
    <div class="card"><span>Inverter</span><strong>${inv ? (inv.ratingW ? fmt(inv.ratingW) + " W" : "too large") : "not needed"}</strong><em>${inv ? "pure sine, sized by " + inv.limitedBy : "DC loads only"}</em></div>
    <div class="card"><span>MPPT controller</span><strong>${r.controller.ratingA ? r.controller.ratingA + " A" : "split array"}</strong><em>at ${r.system.bankVolts} V battery</em></div>
  </div>

  <h3>Single-line diagram</h3>
  ${sld(r)}

  ${r.warnings.length ? `<div class="warn"><strong>Check before you buy:</strong><ul>${r.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>` : ""}

  <h3>Loads</h3>
  <div class="table-scroll"><table class="data"><thead><tr><th>Appliance</th><th class="num">W</th><th class="num">Qty</th><th class="num">h/day</th><th>Type</th><th class="num">Wh/day</th></tr></thead><tbody>
  ${used.map((l) => `<tr><td>${esc(l.name || "Unnamed")}</td><td class="num">${l.watts}</td><td class="num">${l.qty}</td><td class="num">${l.hoursPerDay}</td><td>${l.dc ? "DC" : "AC"}</td><td class="num">${fmt(l.watts * l.qty * l.hoursPerDay)}</td></tr>`).join("")}
  </tbody></table></div>

  <h3>Calculation steps</h3>
  <div class="table-scroll"><table class="data steps"><tbody>
  ${row("Daily energy needed", fmt(r.energy.requiredWh) + " Wh", `DC ${fmt(r.energy.dcWh)} Wh + AC ${fmt(r.energy.acWh)} Wh ÷ ${o.inverterEfficiency} inverter efficiency`)}
  ${row("PV power needed", fmt(r.pv.requiredW) + " W", `${fmt(r.energy.requiredWh)} Wh ÷ (${o.peakSunHours} sun hours × ${o.systemDerate} derate)`)}
  ${row("Panels", `${r.pv.panels} × ${o.panelWatts} W`, `round up ${fmt(r.pv.requiredW)} ÷ ${o.panelWatts}; yields about ${fmt(r.pv.dailyYieldWh)} Wh/day in the design month`)}
  ${row("Battery energy needed", fmt(r.battery.requiredWh) + " Wh", `${fmt(r.energy.requiredWh)} Wh × ${o.autonomyDays} days ÷ (${o.depthOfDischarge} DoD × ${o.batteryEfficiency} efficiency)`)}
  ${row("Battery bank", `${r.battery.series}S × ${r.battery.parallel}P = ${r.battery.bankAh} Ah at ${r.system.bankVolts} V`, `${r.battery.series} in series for ${r.system.nominalVolts} V; parallel strings = round up ${fmt(r.battery.requiredWh)} ÷ (${r.system.bankVolts} V × ${o.batteryUnitAh} Ah). Usable ${fmt(r.battery.usableWh)} Wh`)}
  ${inv ? row("Inverter", inv.ratingW ? fmt(inv.ratingW) + " W" : "n/a", `max of continuous ${fmt(inv.continuousW)} W × 1.25 = ${fmt(inv.minByContinuous)} W and surge ${fmt(inv.surgeW)} W ÷ ${o.inverterSurgeMultiple} = ${fmt(inv.minBySurge)} W, next standard size`) : ""}
  ${row("Charge controller", r.controller.ratingA ? r.controller.ratingA + " A" : "n/a", `${fmt(r.pv.arrayW)} W ÷ ${r.system.bankVolts} V = ${r.controller.chargeCurrentA} A × 1.25 = ${r.controller.minA} A`)}
  ${c1 ? row("Battery to inverter cable", cableTxt(c1), `${c1.currentA} A over ${o.cableBatteryInverterM} m: needs ≥ ${c1.minAreaForDrop} mm² for ${o.maxVoltageDropPct}% drop; fuse ${c1.fuseA ?? "n/a"} A (1.25 × current)${c1.areaMm2 ? `; ${c1.areaMm2} mm² gives ${c1.dropPct}% drop, rated ~${c1.ampacityA} A ≥ fuse` : ""}`) : ""}
  ${row("Controller to battery cable", cableTxt(c2), `${c2.currentA} A over ${o.cableControllerBatteryM} m: needs ≥ ${c2.minAreaForDrop} mm² for ${o.maxVoltageDropPct}% drop; fuse ${c2.fuseA ?? "n/a"} A (1.25 × current)${c2.areaMm2 ? `; ${c2.areaMm2} mm² gives ${c2.dropPct}% drop, rated ~${c2.ampacityA} A ≥ fuse` : ""}`)}
  </tbody></table></div>

  <h3>Not covered by this sizing</h3>
  <ul class="muted"><li>PV string design: check panel Voc at the coldest temperature against the controller's maximum input voltage.</li>
  <li>Fuse and breaker sizes are first estimates: confirm DC voltage ratings, breaking capacity, earthing and surge protection.</li>
  <li>Cable ampacity is indicative (PVC, ~30 °C, free air). Derate for conduit, heat and bundling.</li>
  <li>Peak sun hours should come from the site's worst-month data (e.g. PVGIS or NASA POWER).</li></ul>`;
}

function update() {
  state.loads.forEach((l, i) => {
    const cell = document.querySelector(`tr[data-i="${i}"] [data-wh]`);
    if (cell) cell.textContent = fmt((l.watts || 0) * (l.qty || 0) * (l.hoursPerDay || 0));
  });
  const r = size(state.loads, state.opts);
  $("#report").innerHTML = r.error ? `<div class="warn">${esc(r.error)}</div>` : renderReport(r);
  window.__lastResult = r;
}

$("#print").addEventListener("click", () => window.print());
$("#share").addEventListener("click", async () => {
  const url = shareUrl();
  history.replaceState(null, "", url);
  try { await navigator.clipboard.writeText(url); $("#share-ok").textContent = "Link copied."; }
  catch { $("#share-ok").textContent = "Link is in the address bar."; }
});
$("#csv").addEventListener("click", () => {
  const r = window.__lastResult;
  if (!r || r.error) return;
  const lines = [["Item", "Value"], ["Project", state.project], ["Daily energy (Wh)", r.energy.requiredWh],
    ["System voltage (V)", r.system.nominalVolts], ["Panels", `${r.pv.panels} x ${r.pv.panelWatts} W`], ["Array (W)", r.pv.arrayW],
    ["Battery", `${r.battery.series}S${r.battery.parallel}P, ${r.battery.bankAh} Ah`], ["Battery (Wh)", r.battery.bankWh],
    ["Inverter (W)", r.inverter?.ratingW ?? "none"], ["Controller (A)", r.controller.ratingA ?? "split"],
    ["Battery-inverter cable (mm2)", r.cables.batteryToInverter?.areaMm2 ?? "n/a"], ["Controller-battery cable (mm2)", r.cables.controllerToBattery.areaMm2 ?? "n/a"],
    ...r.warnings.map((w) => ["Warning", w])];
  const csv = lines.map((l) => l.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([csv], { type: "text/csv" })), download: "solar-sizing.csv" });
  a.click(); URL.revokeObjectURL(a.href);
});

loadFromHash();
renderLoads();
syncOptInputs();
update();
