"""Off-grid solar PV + battery sizing (Python port of src/engine.js).

Same method and standard sizes as the browser tool, so results can be
cross-checked between the two implementations. Preliminary design aid only.

CLI:
    python solar_sizing.py loads.csv [--psh 5] [--autonomy 2] [--chem lfp|pb] [--json]

loads.csv columns: name,watts,qty,hours_per_day[,surge_factor][,dc]
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import sys
from dataclasses import dataclass, field, asdict

STANDARD_INVERTER_W = [300, 500, 1000, 1500, 2000, 3000, 4000, 5000, 6000, 8000, 10000]
STANDARD_CONTROLLER_A = [10, 20, 30, 40, 50, 60, 80, 100]
STANDARD_FUSE_A = [10, 15, 20, 25, 30, 40, 50, 63, 80, 100, 125, 160, 200, 250, 300, 400]
STANDARD_MCB_A = [6, 10, 16, 20, 25, 32, 40, 50, 63]
# (mm², indicative ampacity A) single-core PVC, ~30 °C, free air
CABLE_TABLE = [(1.5, 15), (2.5, 21), (4, 28), (6, 36), (10, 50), (16, 66), (25, 84),
               (35, 104), (50, 125), (70, 160), (95, 194), (120, 225)]
COPPER_RESISTIVITY = 0.0175  # ohm·mm²/m
CHEMISTRY = {"lfp": (0.8, 0.95), "pb": (0.5, 0.85)}  # (depth of discharge, round-trip efficiency)


@dataclass
class Load:
    name: str
    watts: float
    qty: int = 1
    hours_per_day: float = 0
    surge_factor: float = 1
    dc: bool = False


@dataclass
class Options:
    peak_sun_hours: float = 5
    system_derate: float = 0.77
    autonomy_days: float = 2
    depth_of_discharge: float = 0.8
    battery_efficiency: float = 0.95
    inverter_efficiency: float = 0.92
    inverter_safety_factor: float = 1.25
    inverter_surge_multiple: float = 2
    controller_safety_factor: float = 1.25
    diversity_factor: float = 1
    panel_watts: float = 550
    battery_unit_volts: float = 12.8
    battery_unit_ah: float = 100
    system_volts: int | str = "auto"
    max_voltage_drop_pct: float = 3
    cable_battery_inverter_m: float = 2
    cable_controller_battery_m: float = 3
    ac_volts: float = 230


@dataclass
class Result:
    required_wh: float
    system_volts: int
    bank_volts: float
    panels: int
    array_w: float
    battery_series: int
    battery_parallel: int
    bank_ah: float
    inverter_w: int | None
    inverter_limited_by: str | None
    ac_breaker_a: int | None
    controller_a: int | None
    cables: dict = field(default_factory=dict)
    warnings: list = field(default_factory=list)


def _pick(standard: list, minimum: float):
    return next((v for v in standard if v >= minimum), None)


def choose_system_volts(required_wh: float, continuous_w: float) -> int:
    if continuous_w > 2500 or required_wh > 5000:
        return 48
    if continuous_w > 800 or required_wh > 2000:
        return 24
    return 12


def size_cable(current_a: float, length_m: float, system_volts: float, max_drop_pct: float) -> dict:
    allowed_drop_v = system_volts * max_drop_pct / 100
    min_area = 2 * length_m * current_a * COPPER_RESISTIVITY / allowed_drop_v
    fuse_a = _pick(STANDARD_FUSE_A, current_a * 1.25)
    row = next(((a, amps) for a, amps in CABLE_TABLE if a >= min_area and fuse_a and amps >= fuse_a), None)
    out = {"current_a": round(current_a, 1), "min_area_for_drop": round(min_area, 2), "fuse_a": fuse_a,
           "area_mm2": None, "drop_pct": None}
    if row:
        drop_v = 2 * length_m * current_a * COPPER_RESISTIVITY / row[0]
        out.update(area_mm2=row[0], ampacity_a=row[1], drop_pct=round(drop_v / system_volts * 100, 2))
    return out


def size(loads: list[Load], o: Options | None = None) -> Result:
    o = o or Options()
    loads = [l for l in loads if l.watts > 0 and l.qty > 0 and l.hours_per_day > 0]
    if not loads:
        raise ValueError("Add at least one load with watts, quantity and hours per day above zero.")
    if any(l.hours_per_day > 24 for l in loads):
        raise ValueError("Hours per day cannot exceed 24.")

    ac = [l for l in loads if not l.dc]
    ac_wh = sum(l.watts * l.qty * l.hours_per_day for l in ac)
    dc_wh = sum(l.watts * l.qty * l.hours_per_day for l in loads if l.dc)
    required_wh = dc_wh + ac_wh / o.inverter_efficiency
    continuous_w = sum(l.watts * l.qty for l in ac) * o.diversity_factor
    recommended = choose_system_volts(required_wh, continuous_w)
    volts = recommended if o.system_volts == "auto" else int(o.system_volts)
    series = max(1, round(volts / o.battery_unit_volts))
    bank_v = series * o.battery_unit_volts
    warnings = []

    panels = math.ceil(required_wh / (o.peak_sun_hours * o.system_derate) / o.panel_watts)
    array_w = panels * o.panel_watts
    battery_wh = required_wh * o.autonomy_days / (o.depth_of_discharge * o.battery_efficiency)
    parallel = math.ceil(battery_wh / (bank_v * o.battery_unit_ah))

    inverter_w = limited_by = breaker = None
    if ac:
        surge_extra = max(l.watts * l.qty * (l.surge_factor - 1) for l in ac)
        by_cont = continuous_w * o.inverter_safety_factor
        by_surge = (continuous_w + surge_extra) / o.inverter_surge_multiple
        inverter_w = _pick(STANDARD_INVERTER_W, max(by_cont, by_surge))
        limited_by = "surge" if by_surge > by_cont else "continuous load"
        breaker = _pick(STANDARD_MCB_A, inverter_w / o.ac_volts * 1.25) if inverter_w else None
        if not inverter_w:
            warnings.append("Inverter larger than 10 kW needed.")

    charge_a = array_w / bank_v
    controller = _pick(STANDARD_CONTROLLER_A, charge_a * o.controller_safety_factor)
    if not controller:
        warnings.append("Charge current exceeds 100 A; split the array or raise system voltage.")

    cables = {"controller_to_battery": size_cable(charge_a, o.cable_controller_battery_m, bank_v, o.max_voltage_drop_pct)}
    if inverter_w:
        inv_a = inverter_w / (bank_v * o.inverter_efficiency)
        cables["battery_to_inverter"] = size_cable(inv_a, o.cable_battery_inverter_m, bank_v, o.max_voltage_drop_pct)
    if o.autonomy_days < 1:
        warnings.append("Less than one day of autonomy.")
    if not 2 <= o.peak_sun_hours <= 7:
        warnings.append("Peak sun hours outside 2-7 is unusual.")
    if volts < recommended:
        warnings.append(f"A {recommended} V system is usually more practical for this load.")

    return Result(round(required_wh, 1), volts, round(bank_v, 2), panels, array_w, series, parallel,
                  parallel * o.battery_unit_ah, inverter_w, limited_by, breaker, controller, cables, warnings)


def read_loads(path: str) -> list[Load]:
    with open(path, newline="", encoding="utf-8-sig") as f:
        return [Load(name=r["name"], watts=float(r["watts"]), qty=int(r.get("qty") or 1),
                     hours_per_day=float(r["hours_per_day"]), surge_factor=float(r.get("surge_factor") or 1),
                     dc=str(r.get("dc", "")).strip().lower() in ("1", "true", "yes", "dc"))
                for r in csv.DictReader(f)]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Off-grid solar PV + battery sizing")
    ap.add_argument("loads_csv")
    ap.add_argument("--psh", type=float, default=5, help="worst-month peak sun hours")
    ap.add_argument("--autonomy", type=float, default=2, help="days of autonomy")
    ap.add_argument("--chem", choices=CHEMISTRY, default="lfp")
    ap.add_argument("--json", action="store_true", help="print full result as JSON")
    a = ap.parse_args(argv)
    dod, eff = CHEMISTRY[a.chem]
    try:
        r = size(read_loads(a.loads_csv), Options(peak_sun_hours=a.psh, autonomy_days=a.autonomy,
                                                   depth_of_discharge=dod, battery_efficiency=eff))
    except (ValueError, KeyError, OSError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    if a.json:
        print(json.dumps(asdict(r), indent=2))
        return 0
    print(f"Daily energy      {r.required_wh:,.0f} Wh  ({r.system_volts} V system)")
    print(f"PV array          {r.panels} x 550 W = {r.array_w:,.0f} W")
    print(f"Battery           {r.battery_series}S{r.battery_parallel}P = {r.bank_ah:,.0f} Ah at {r.bank_volts} V")
    print(f"Inverter          {r.inverter_w or '-'} W ({r.inverter_limited_by or 'no AC loads'}), AC MCB {r.ac_breaker_a or '-'} A")
    print(f"MPPT controller   {r.controller_a or 'split'} A")
    for name, c in r.cables.items():
        print(f"{name.replace('_', ' '):<18}{c['area_mm2'] or 'n/a'} mm2, fuse {c['fuse_a']} A, drop {c['drop_pct']}%")
    for w in r.warnings:
        print(f"WARNING: {w}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
