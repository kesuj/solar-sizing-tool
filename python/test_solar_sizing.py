"""PyTest suite. Hand-calculated expectations match test/engine.test.js, and a
cross-check test runs the JavaScript engine (if Node is available) to make sure
both implementations agree on random load sets."""
import json
import random
import shutil
import subprocess
from pathlib import Path

import pytest

from solar_sizing import Load, Options, choose_system_volts, main, size, size_cable

CLINIC = [
    Load("LED light", 10, 5, 6),
    Load("Fridge", 100, 1, 10, surge_factor=5),
    Load("Laptop", 65, 1, 4),
]


def test_clinic_matches_hand_calculation():
    r = size(CLINIC)
    assert r.required_wh == pytest.approx(1695.7, abs=0.05)      # 1560 / 0.92
    assert r.system_volts == 12
    assert r.panels == 1                                           # 440.4 W needed
    assert (r.battery_series, r.battery_parallel, r.bank_ah) == (1, 4, 400)
    assert (r.inverter_w, r.inverter_limited_by) == (500, "surge")  # 615 W surge / 2
    assert r.ac_breaker_a == 6
    assert r.controller_a == 60                                    # 42.97 A x 1.25
    assert r.cables["battery_to_inverter"]["fuse_a"] == 63
    assert r.cables["battery_to_inverter"]["area_mm2"] == 16       # 10 mm2 is only 50 A < 63 A fuse
    assert r.cables["controller_to_battery"]["area_mm2"] == 16
    assert r.warnings == []


@pytest.mark.parametrize("wh,w,expected", [(1500, 500, 12), (3000, 500, 24), (1500, 1200, 24), (6000, 2000, 48), (3000, 3000, 48)])
def test_system_voltage(wh, w, expected):
    assert choose_system_volts(wh, w) == expected


def test_cable_must_carry_fuse_rating():
    c = size_cable(60, 0.5, 48, 3)
    assert (c["fuse_a"], c["area_mm2"]) == (80, 25)


def test_lead_acid_needs_bigger_bank():
    li = size(CLINIC)
    pb = size(CLINIC, Options(depth_of_discharge=0.5, battery_efficiency=0.85))
    assert pb.bank_ah > li.bank_ah


@pytest.mark.parametrize("loads", [[], [Load("x", 10, 1, 30)]])
def test_invalid_input_raises(loads):
    with pytest.raises(ValueError):
        size(loads)


def test_dc_only_has_no_inverter():
    r = size([Load("DC fan", 20, 3, 5, dc=True)])
    assert r.inverter_w is None and "battery_to_inverter" not in r.cables
    assert r.required_wh == 300


def test_cli_prints_summary(tmp_path, capsys):
    f = tmp_path / "loads.csv"
    f.write_text("name,watts,qty,hours_per_day,surge_factor\nLED light,10,5,6,1\nFridge,100,1,10,5\nLaptop,65,1,4,1\n")
    assert main([str(f)]) == 0
    out = capsys.readouterr().out
    assert "1S4P = 400 Ah" in out and "500 W (surge)" in out


def test_cli_reports_bad_file(tmp_path, capsys):
    f = tmp_path / "bad.csv"
    f.write_text("name,watts\nLamp,10\n")
    assert main([str(f)]) == 1
    assert "error" in capsys.readouterr().err


@pytest.mark.skipif(shutil.which("node") is None, reason="Node.js not installed")
def test_python_and_javascript_engines_agree():
    rng = random.Random(42)
    cases = []
    for _ in range(40):
        loads = [{"name": f"L{i}", "watts": rng.choice([5, 10, 40, 60, 100, 150, 400, 750, 1200]),
                  "qty": rng.randint(1, 4), "hoursPerDay": rng.choice([1, 2, 4, 6, 8, 12]),
                  "surgeFactor": rng.choice([1, 1, 3, 5]), "dc": rng.random() < 0.15} for i in range(rng.randint(1, 5))]
        cases.append({"loads": loads, "psh": rng.choice([3.5, 4.5, 5.5]), "autonomy": rng.choice([1, 2, 3])})
    engine = (Path(__file__).resolve().parent.parent / "src" / "engine.js").as_uri()
    script = f"""
      const {{ size }} = await import({json.dumps(engine)});
      const cases = JSON.parse(process.argv[1]);
      console.log(JSON.stringify(cases.map(c => size(c.loads, {{ peakSunHours: c.psh, autonomyDays: c.autonomy }}))));
    """
    out = subprocess.run(["node", "--input-type=module", "-e", script, json.dumps(cases)],
                         capture_output=True, text=True, check=True).stdout
    js_results = json.loads(out)
    for case, js in zip(cases, js_results):
        py = size([Load(l["name"], l["watts"], l["qty"], l["hoursPerDay"], l["surgeFactor"], l["dc"]) for l in case["loads"]],
                  Options(peak_sun_hours=case["psh"], autonomy_days=case["autonomy"]))
        assert py.system_volts == js["system"]["nominalVolts"]
        assert py.panels == js["pv"]["panels"]
        assert (py.battery_series, py.battery_parallel) == (js["battery"]["series"], js["battery"]["parallel"])
        assert py.inverter_w == (js["inverter"] or {}).get("ratingW")
        assert py.controller_a == js["controller"]["ratingA"]
        js_cable = js["cables"]["controllerToBattery"]
        assert py.cables["controller_to_battery"]["area_mm2"] == js_cable["areaMm2"]
