// Run: npm test
// Expected values were worked out by hand (see comments) before running the code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { size, sizeCable, chooseSystemVolts, dailyEnergy } from "../src/engine.js";

// Off-grid clinic example: 5 LED lights, a fridge (duty-cycled ~10 h/day, 5x start surge), a laptop.
const clinic = [
  { name: "LED light", watts: 10, qty: 5, hoursPerDay: 6 },
  { name: "Fridge", watts: 100, qty: 1, hoursPerDay: 10, surgeFactor: 5 },
  { name: "Laptop", watts: 65, qty: 1, hoursPerDay: 4 },
];

test("daily energy splits AC and DC loads", () => {
  assert.deepEqual(dailyEnergy([...clinic, { watts: 5, qty: 2, hoursPerDay: 10, dc: true }]), { acWh: 1560, dcWh: 100 });
});

test("clinic example matches hand calculation", () => {
  const r = size(clinic);
  // 1560 Wh AC / 0.92 inverter efficiency = 1695.65 Wh
  assert.equal(r.energy.requiredWh, 1695.7);
  // 215 W continuous and < 2 kWh/day -> 12 V; one 12.8 V LiFePO4 unit in series
  assert.equal(r.system.nominalVolts, 12);
  assert.equal(r.battery.series, 1);
  // 1695.65 / (5 h x 0.77) = 440.4 W -> one 550 W panel
  assert.equal(r.pv.requiredW, 440.4);
  assert.equal(r.pv.panels, 1);
  // 1695.65 x 2 days / (0.8 x 0.95) = 4462.2 Wh -> 3.49 x 1280 Wh units -> 4 in parallel
  assert.equal(r.battery.requiredWh, 4462.2);
  assert.equal(r.battery.parallel, 4);
  assert.equal(r.battery.bankAh, 400);
  // Continuous 215 x 1.25 = 268.75 W, but surge 215 + 400 = 615 W needs 307.5 W -> 500 W inverter
  assert.equal(r.inverter.surgeW, 615);
  assert.equal(r.inverter.ratingW, 500);
  assert.equal(r.inverter.limitedBy, "surge");
  // 550 W / 12.8 V = 42.97 A x 1.25 = 53.7 A -> 60 A MPPT
  assert.equal(r.controller.ratingA, 60);
  // Battery-inverter: 500 / (12.8 x 0.92) = 42.46 A over 2 m, 3% drop -> needs 7.74 mm² (10 mm² by drop),
  // but the fuse is 42.46 x 1.25 = 53.1 -> 63 A and 10 mm² is only ~50 A, so the cable goes up to 16 mm² (66 A).
  assert.equal(r.cables.batteryToInverter.fuseA, 63);
  assert.equal(r.cables.batteryToInverter.areaMm2, 16);
  // Controller-battery: 42.97 A over 3 m -> needs 11.75 mm² -> 16 mm²; fuse 53.7 -> 63 A, within 66 A
  assert.equal(r.cables.controllerToBattery.areaMm2, 16);
  assert.equal(r.cables.controllerToBattery.fuseA, 63);
  // AC output: 500 W / 230 V = 2.17 A x 1.25 = 2.7 A -> 6 A MCB
  assert.equal(r.inverter.acBreakerA, 6);
  assert.deepEqual(r.warnings, []);
});

test("system voltage steps up with load", () => {
  assert.equal(chooseSystemVolts(1500, 500), 12);
  assert.equal(chooseSystemVolts(3000, 500), 24);
  assert.equal(chooseSystemVolts(1500, 1200), 24);
  assert.equal(chooseSystemVolts(6000, 2000), 48);
  assert.equal(chooseSystemVolts(3000, 3000), 48);
});

test("48 V system uses four 12.8 V units in series", () => {
  const r = size([{ watts: 1500, qty: 1, hoursPerDay: 4 }, { watts: 400, qty: 2, hoursPerDay: 8 }]);
  assert.equal(r.system.nominalVolts, 48);
  assert.equal(r.battery.series, 4);
  assert.equal(r.battery.units, r.battery.series * r.battery.parallel);
});

test("cable sizing respects ampacity even when voltage drop is small", () => {
  // 60 A over 0.5 m at 48 V: drop needs only 0.73 mm², but the fuse is 75 -> 80 A, so 25 mm² (84 A)
  const c = sizeCable(60, 0.5, 48, 3);
  assert.equal(c.fuseA, 80);
  assert.equal(c.areaMm2, 25);
  assert.ok(c.dropPct < 3);
});

test("cable sizing reports when nothing fits", () => {
  assert.equal(sizeCable(400, 10, 12, 3).areaMm2, null);
});

test("lead-acid settings need a bigger bank than LiFePO4", () => {
  const li = size(clinic);
  const pb = size(clinic, { depthOfDischarge: 0.5, batteryEfficiency: 0.85 });
  assert.ok(pb.battery.requiredWh > li.battery.requiredWh * 1.7);
});

test("invalid input returns an error instead of numbers", () => {
  assert.ok(size([]).error);
  assert.ok(size([{ watts: 10, qty: 1, hoursPerDay: 30 }]).error);
});

test("warnings flag risky choices", () => {
  const r = size(clinic, { autonomyDays: 0.5, peakSunHours: 1.5 });
  assert.ok(r.warnings.some((w) => w.includes("autonomy")));
  assert.ok(r.warnings.some((w) => w.includes("Peak sun hours")));
  const forced = size([{ watts: 3000, qty: 1, hoursPerDay: 3 }], { systemVolts: 12 });
  assert.ok(forced.warnings.some((w) => w.includes("48 V")));
});

test("DC-only system needs no inverter", () => {
  const r = size([{ watts: 20, qty: 3, hoursPerDay: 5, dc: true }]);
  assert.equal(r.inverter, null);
  assert.equal(r.cables.batteryToInverter, null);
  assert.equal(r.energy.requiredWh, 300);
});
