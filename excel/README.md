# Off-Grid Solar Sizing Workbook (Excel)

A formula-only Excel workbook (no macros) that sizes a first-pass off-grid solar PV + battery system. It is a port of the tested JavaScript engine in `../src/engine.js` and gives the same answers for the same inputs.

**File:** `Off-Grid-Solar-Sizing-Workbook.xlsx` (Excel 2016 or later; also opens in LibreOffice Calc). No `LET`, `LAMBDA`, `XLOOKUP` or dynamic arrays are used.

## Sheets

| Sheet | Purpose |
|---|---|
| **Inputs** | Loads table (up to 25 rows: appliance, watts, qty, hours/day, surge x, DC?) and the site/equipment assumptions (same defaults as `DEFAULTS` in `engine.js`). System voltage dropdown: auto / 12 / 24 / 48. |
| **Results** | Every intermediate number: daily energy, system voltage, PV W and panel count, battery Wh / series / parallel / Ah, inverter rating (standard-size lookup with the surge rule), MPPT rating, fuse ratings, cable sizes (ampacity >= fuse AND area >= voltage-drop minimum), AC MCB, warnings. |
| **Report** | Printable one-page summary (print area and fit-to-page set): bill of materials, each formula step written out with the numbers, warnings, assumptions, disclaimer. |
| **Tables** | Standard inverter, controller, fuse and MCB sizes, copper cable table (mm2 / ampacity), copper resistivity. Editable; keep lists sorted ascending. |
| **Read me** | How to use, method, limits, disclaimer, licence. |

Yellow cells are inputs (unlocked); grey cells are formulas. All sheets are protected **without a password** so formulas are not overwritten by accident (Review > Unprotect Sheet to change the layout). About 90 named ranges (`RequiredWh`, `InverterW`, `BI_Area`, ...) drive every formula, so the Results sheet is easy to audit or extend.

## How to use

1. On **Inputs**, list the loads. "Surge x" is the motor start-up multiple (fridge/pump 3-5; blank = 1). "DC?" = Yes for loads wired straight to the battery.
2. Check the assumptions block (peak sun hours from PVGIS / NASA POWER worst month, battery DoD and efficiency for the chemistry, cable lengths, AC voltage).
3. Leave system voltage on `auto` or force 12 / 24 / 48 V (a warning appears if the forced voltage is lower than the auto rule suggests).
4. Read **Results**, or print / Save-As-PDF the **Report** sheet.

## Method

Identical to the README in the project root: daily Wh = DC Wh + AC Wh / inverter efficiency; auto voltage 12/24/48 V by load thresholds; PV = Wh / (PSH x derate) rounded up to whole panels; battery = Wh x autonomy / (DoD x efficiency) with series = V / unit V and parallel strings rounded up; inverter = next standard size >= max(continuous x 1.25, surge / 2); MPPT = array W / bank V x 1.25; fuse = next standard >= 1.25 x I; cable = smallest size with drop <= limit (2-wire run) **and** ampacity >= fuse; AC MCB = inverter W / AC V x 1.25.

"Next standard size" is done with `INDEX(list, COUNTIF(list,"<"&min)+1)` on ascending lists; the cable pick is `MAX(COUNTIF(area,"<"&minArea), COUNTIF(ampacity,"<"&fuse))+1`, which is the first row satisfying both conditions.

## Verification

`verify_workbook.ps1` drives real Excel through COM (hidden instance), types the two test cases from `../test/engine.test.js` into the Inputs sheet, forces a full recalculation, reads the named result cells and compares them with the hand-checked numbers (1 % tolerance). It also exports `sample-report.pdf` from the Report sheet.

```powershell
powershell -ExecutionPolicy Bypass -File excel/verify_workbook.ps1
```

Last run (Excel 2016+ / Microsoft 365, Windows 11):

```
=== Clinic example (engine.test.js) ===
PASS  Status                 got OK
PASS  RequiredWh             got 1695.65217391304
PASS  NominalVolts           got 12
PASS  Series                 got 1
PASS  PvRequiredW            got 440.42913608131
PASS  Panels                 got 1
PASS  PvArrayW               got 550
PASS  BatteryWhRequired      got 4462.24256292906
PASS  Parallel               got 4
PASS  BankAh                 got 400
PASS  SurgeW                 got 615
PASS  InverterW              got 500
PASS  LimitedBy              got surge
PASS  ControllerA            got 60
PASS  BI_FuseA               got 63
PASS  BI_Area (mm2)          got 16
PASS  CB_FuseA               got 63
PASS  CB_Area (mm2)          got 16
PASS  AcBreakerA             got 6
PASS  WarningCount           got 0
PDF   excel/sample-report.pdf
=== 48 V example (engine.test.js) ===
PASS  NominalVolts           got 48
PASS  Series                 got 4
PASS  Parallel               got 7
PASS  BatteryUnits           got 28
PASS  InverterW              got 3000
=== Extra checks ===
PASS  Forced 12V warning present  got 1
RESULT: 26 passed, 0 failed
```

## Rebuilding

`build_workbook.py` regenerates the workbook with openpyxl (`python excel/build_workbook.py`). Edit the script, rebuild, re-run the verifier.

## Limits

- No PV string design (Voc at cold temperature vs controller maximum input voltage is not checked).
- No detailed protection coordination; fuse and MCB sizes are first estimates.
- Cable ampacities are indicative (single-core PVC copper, free air, ~30 C); derate for conduit, heat and bundling.
- Inverter surge capability assumed to be the "surge multiple" (default 2x) of continuous rating.
- 25 load rows; standard-size lists are fixed length unless you extend the named ranges.
- Preliminary design aid, not a stamped engineering design. Check against local codes, datasheets and site conditions with a qualified person.
