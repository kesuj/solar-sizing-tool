// Off-grid solar PV + battery sizing engine. Pure functions, no dependencies.
// Preliminary design aid only: results must be checked by a qualified engineer
// against local codes and the actual equipment datasheets.

export const STANDARD_INVERTER_W = [300, 500, 1000, 1500, 2000, 3000, 4000, 5000, 6000, 8000, 10000];
export const STANDARD_CONTROLLER_A = [10, 20, 30, 40, 50, 60, 80, 100];
// Copper conductor sizes (mm²) with indicative continuous ampacity (A) for
// single-core PVC cable in free air at ~30 °C. Derate for conduit/heat/bundling.
export const CABLE_TABLE = [
  [1.5, 15], [2.5, 21], [4, 28], [6, 36], [10, 50], [16, 66], [25, 84],
  [35, 104], [50, 125], [70, 160], [95, 194], [120, 225],
];
export const COPPER_RESISTIVITY = 0.0175; // ohm·mm²/m at ~20 °C
export const STANDARD_FUSE_A = [10, 15, 20, 25, 30, 40, 50, 63, 80, 100, 125, 160, 200, 250, 300, 400];
export const STANDARD_MCB_A = [6, 10, 16, 20, 25, 32, 40, 50, 63];

export const DEFAULTS = {
  peakSunHours: 5,
  systemDerate: 0.77,      // temperature, dust, wiring, mismatch, controller losses
  autonomyDays: 2,
  depthOfDischarge: 0.8,   // LiFePO4 ~0.8, lead-acid ~0.5
  batteryEfficiency: 0.95, // round-trip, LiFePO4 ~0.95, lead-acid ~0.85
  inverterEfficiency: 0.92,
  inverterSafetyFactor: 1.25,
  inverterSurgeMultiple: 2, // typical inverter surge rating vs continuous rating
  controllerSafetyFactor: 1.25,
  diversityFactor: 1,       // share of AC loads running at the same time
  panelWatts: 550,
  batteryUnitVolts: 12.8,
  batteryUnitAh: 100,
  systemVolts: "auto",      // 12 | 24 | 48 | "auto"
  maxVoltageDropPct: 3,
  cableBatteryInverterM: 2,
  cableControllerBatteryM: 3,
  acVolts: 230,
};

const round = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d;
const pickStandard = (list, min) => list.find((v) => v >= min) ?? null;

export function dailyEnergy(loads) {
  let acWh = 0, dcWh = 0;
  for (const l of loads) {
    const wh = l.watts * l.qty * l.hoursPerDay;
    if (l.dc) dcWh += wh; else acWh += wh;
  }
  return { acWh, dcWh };
}

export function chooseSystemVolts(requiredWh, continuousW) {
  if (continuousW > 2500 || requiredWh > 5000) return 48;
  if (continuousW > 800 || requiredWh > 2000) return 24;
  return 12;
}

export function sizeCable(currentA, lengthM, systemVolts, maxDropPct) {
  const allowedDropV = systemVolts * (maxDropPct / 100);
  // Two-wire DC circuit: conductor length is out and back.
  const minAreaForDrop = (2 * lengthM * currentA * COPPER_RESISTIVITY) / allowedDropV;
  // Fuse at 1.25x the design current; the cable must carry at least the fuse rating.
  const fuseA = pickStandard(STANDARD_FUSE_A, currentA * 1.25);
  const row = fuseA && CABLE_TABLE.find(([area, amps]) => area >= minAreaForDrop && amps >= fuseA);
  if (!row) return { currentA: round(currentA), minAreaForDrop: round(minAreaForDrop, 2), fuseA, areaMm2: null, dropPct: null };
  const dropV = (2 * lengthM * currentA * COPPER_RESISTIVITY) / row[0];
  return {
    currentA: round(currentA), minAreaForDrop: round(minAreaForDrop, 2), fuseA,
    areaMm2: row[0], ampacityA: row[1], dropPct: round((dropV / systemVolts) * 100, 2),
  };
}

export function size(loads, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const warnings = [];
  const valid = loads.filter((l) => l.watts > 0 && l.qty > 0 && l.hoursPerDay > 0);
  if (!valid.length) return { error: "Add at least one load with watts, quantity and hours per day above zero." };
  if (valid.some((l) => l.hoursPerDay > 24)) return { error: "Hours per day cannot exceed 24." };

  const { acWh, dcWh } = dailyEnergy(valid);
  const requiredWh = dcWh + acWh / o.inverterEfficiency;
  const acLoads = valid.filter((l) => !l.dc);
  const continuousW = acLoads.reduce((s, l) => s + l.watts * l.qty, 0) * o.diversityFactor;

  const nominalVolts = o.systemVolts === "auto" ? chooseSystemVolts(requiredWh, continuousW) : Number(o.systemVolts);
  const series = Math.max(1, Math.round(nominalVolts / o.batteryUnitVolts));
  const bankVolts = series * o.batteryUnitVolts;

  // PV array
  const pvWattsRequired = requiredWh / (o.peakSunHours * o.systemDerate);
  const panels = Math.ceil(pvWattsRequired / o.panelWatts);
  const pvArrayW = panels * o.panelWatts;

  // Battery bank
  const batteryWhRequired = (requiredWh * o.autonomyDays) / (o.depthOfDischarge * o.batteryEfficiency);
  const parallel = Math.ceil(batteryWhRequired / (bankVolts * o.batteryUnitAh));
  const batteryUnits = series * parallel;
  const bankAh = parallel * o.batteryUnitAh;
  const bankWh = bankAh * bankVolts;

  // Inverter: continuous rating with margin, and surge capability for motor loads.
  let inverter = null, surgeW = 0;
  if (acLoads.length) {
    const surgeExtra = Math.max(...acLoads.map((l) => l.watts * l.qty * ((l.surgeFactor || 1) - 1)));
    surgeW = continuousW + surgeExtra;
    const minByContinuous = continuousW * o.inverterSafetyFactor;
    const minBySurge = surgeW / o.inverterSurgeMultiple;
    const inverterW = pickStandard(STANDARD_INVERTER_W, Math.max(minByContinuous, minBySurge));
    const acBreakerA = inverterW ? pickStandard(STANDARD_MCB_A, (inverterW / o.acVolts) * 1.25) : null;
    inverter = { continuousW: round(continuousW), surgeW: round(surgeW), minByContinuous: round(minByContinuous),
      minBySurge: round(minBySurge), ratingW: inverterW, limitedBy: minBySurge > minByContinuous ? "surge" : "continuous load",
      acBreakerA };
    if (!inverterW) warnings.push(`Inverter above ${STANDARD_INVERTER_W.at(-1)} W needed; use parallel inverters or reduce simultaneous load.`);
  }

  // Charge controller (MPPT), battery-side current.
  const chargeCurrentA = pvArrayW / bankVolts;
  const controllerMinA = chargeCurrentA * o.controllerSafetyFactor;
  const controllerA = pickStandard(STANDARD_CONTROLLER_A, controllerMinA);
  if (!controllerA) warnings.push(`Charge current ${round(controllerMinA)} A exceeds ${STANDARD_CONTROLLER_A.at(-1)} A; split the array across several controllers or use a higher system voltage.`);

  // Cables
  const inverterInputA = inverter?.ratingW ? inverter.ratingW / (bankVolts * o.inverterEfficiency) : 0;
  const cables = {
    batteryToInverter: inverter?.ratingW ? sizeCable(inverterInputA, o.cableBatteryInverterM, bankVolts, o.maxVoltageDropPct) : null,
    controllerToBattery: sizeCable(chargeCurrentA, o.cableControllerBatteryM, bankVolts, o.maxVoltageDropPct),
  };
  for (const [name, c] of Object.entries(cables)) {
    if (c && c.areaMm2 === null) warnings.push(`No standard cable up to 120 mm² meets the ${name === "batteryToInverter" ? "battery-inverter" : "controller-battery"} run; shorten it or raise system voltage.`);
  }

  if (o.peakSunHours < 2 || o.peakSunHours > 7) warnings.push("Peak sun hours outside 2-7 is unusual; check the site's worst-month solar data.");
  if (o.autonomyDays < 1) warnings.push("Less than one day of autonomy: loads will fail after a cloudy day.");
  if (inverterInputA > 150) warnings.push(`Battery current about ${round(inverterInputA)} A is high; a higher system voltage would reduce cable size and losses.`);
  if (o.systemVolts !== "auto" && Number(o.systemVolts) < chooseSystemVolts(requiredWh, continuousW))
    warnings.push(`For this load a ${chooseSystemVolts(requiredWh, continuousW)} V system is usually more practical.`);

  return {
    inputs: o,
    energy: { acWh: round(acWh), dcWh: round(dcWh), requiredWh: round(requiredWh) },
    system: { nominalVolts, bankVolts: round(bankVolts, 2) },
    pv: { requiredW: round(pvWattsRequired), panelWatts: o.panelWatts, panels, arrayW: pvArrayW,
      dailyYieldWh: round(pvArrayW * o.peakSunHours * o.systemDerate) },
    battery: { requiredWh: round(batteryWhRequired), series, parallel, units: batteryUnits, bankAh, bankWh: round(bankWh),
      usableWh: round(bankWh * o.depthOfDischarge) },
    inverter,
    controller: { chargeCurrentA: round(chargeCurrentA), minA: round(controllerMinA), ratingA: controllerA },
    cables,
    warnings,
  };
}
