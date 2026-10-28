# Verifies Off-Grid-Solar-Sizing-Workbook.xlsx against the hand-checked numbers in test/engine.test.js
# using Excel itself (COM). Run: powershell -ExecutionPolicy Bypass -File excel/verify_workbook.ps1
$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$xlsx = Join-Path $dir "Off-Grid-Solar-Sizing-Workbook.xlsx"
$pdf = Join-Path $dir "sample-report.pdf"
if (-not (Test-Path $xlsx)) { throw "Workbook not found: $xlsx" }

$script:pass = 0; $script:fail = 0
function Check($name, $actual, $expected) {
    $ok = $false
    if ($expected -is [string]) { $ok = ("$actual" -eq $expected) }
    else {
        $a = [double]$actual; $e = [double]$expected
        $tol = [Math]::Max([Math]::Abs($e) * 0.01, 1e-9)
        $ok = ([Math]::Abs($a - $e) -le $tol)
    }
    if ($ok) { $script:pass++; Write-Output ("PASS  {0,-32} got {1}" -f $name, $actual) }
    else     { $script:fail++; Write-Output ("FAIL  {0,-32} got {1}  expected {2}" -f $name, $actual, $expected) }
}

$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false
try {
    $wb = $excel.Workbooks.Open($xlsx)
    $inputs = $wb.Worksheets.Item("Inputs")
    function N($name) { return $wb.Names.Item($name).RefersToRange.Value2 }
    # Late-bound property set: avoids the PowerShell COM adapter inferring a type from the cell's current value.
    function SetVal($rng, $value) {
        [void][System.__ComObject].InvokeMember("Value2", [System.Reflection.BindingFlags]::SetProperty, $null, $rng, @($value))
    }
    function SetName([string]$name, $value) { SetVal $wb.Names.Item($name).RefersToRange $value }
    function ClearLoads() { $inputs.Range("A8:F32").ClearContents() | Out-Null }
    function SetLoad($row, $name, $w, $qty, $h, $surge, $dc) {
        SetVal $inputs.Cells.Item($row, 1) $name
        SetVal $inputs.Cells.Item($row, 2) $w
        SetVal $inputs.Cells.Item($row, 3) $qty
        SetVal $inputs.Cells.Item($row, 4) $h
        if ($null -ne $surge) { SetVal $inputs.Cells.Item($row, 5) $surge }
        SetVal $inputs.Cells.Item($row, 6) $dc
    }
    function SetDefaults() {
        $d = @{ PeakSunHours = 5; SystemDerate = 0.77; AutonomyDays = 2; DepthOfDischarge = 0.8; BatteryEfficiency = 0.95
                InverterEfficiency = 0.92; InverterSafetyFactor = 1.25; InverterSurgeMultiple = 2; ControllerSafetyFactor = 1.25
                DiversityFactor = 1; PanelWatts = 550; BatteryUnitVolts = 12.8; BatteryUnitAh = 100; SystemVoltsSel = "auto"
                MaxVoltageDropPct = 3; CableBatteryInverterM = 2; CableControllerBatteryM = 3; AcVolts = 230 }
        foreach ($k in $d.Keys) { SetName $k $d[$k] }
    }

    # ---------------- Clinic example ----------------
    Write-Output "=== Clinic example (engine.test.js) ==="
    SetDefaults
    ClearLoads
    SetLoad 8  "LED light" 10 5 6 $null "No"
    SetLoad 9  "Fridge"   100 1 10 5    "No"
    SetLoad 10 "Laptop"    65 1 4 $null "No"
    SetName "ProjectName" "Rural clinic (example)"
    $excel.CalculateFull()

    Check "Status"            (N "Status")            "OK"
    Check "RequiredWh"        (N "RequiredWh")        1695.7
    Check "NominalVolts"      (N "NominalVolts")      12
    Check "Series"            (N "Series")            1
    Check "PvRequiredW"       (N "PvRequiredW")       440.4
    Check "Panels"            (N "Panels")            1
    Check "PvArrayW"          (N "PvArrayW")          550
    Check "BatteryWhRequired" (N "BatteryWhRequired") 4462.2
    Check "Parallel"          (N "Parallel")          4
    Check "BankAh"            (N "BankAh")            400
    Check "SurgeW"            (N "SurgeW")            615
    Check "InverterW"         (N "InverterW")         500
    Check "LimitedBy"         (N "LimitedBy")         "surge"
    Check "ControllerA"       (N "ControllerA")       60
    Check "BI_FuseA"          (N "BI_FuseA")          63
    Check "BI_Area (mm2)"     (N "BI_Area")           16
    Check "CB_FuseA"          (N "CB_FuseA")          63
    Check "CB_Area (mm2)"     (N "CB_Area")           16
    Check "AcBreakerA"        (N "AcBreakerA")        6
    Check "WarningCount"      (N "WarningCount")      0

    # PDF of the Report sheet for the clinic example
    if (Test-Path $pdf) { Remove-Item $pdf -Force }
    $wb.Worksheets.Item("Report").ExportAsFixedFormat(0, $pdf) | Out-Null
    Write-Output ("PDF   {0} ({1} bytes)" -f $pdf, (Get-Item $pdf).Length)

    # ---------------- 48 V example ----------------
    Write-Output "=== 48 V example (engine.test.js) ==="
    ClearLoads
    SetLoad 8 "Heater" 1500 1 4 $null "No"
    SetLoad 9 "Pump"    400 2 8 $null "No"
    $excel.CalculateFull()
    Check "NominalVolts"  (N "NominalVolts")  48
    Check "Series"        (N "Series")        4
    Check "Parallel"      (N "Parallel")      7
    Check "BatteryUnits"  (N "BatteryUnits")  ([double](N "Series") * [double](N "Parallel"))
    Check "InverterW"     (N "InverterW")     3000

    # ---------------- Extra: cable ampacity rule & forced-voltage warning ----------------
    Write-Output "=== Extra checks ==="
    ClearLoads
    SetLoad 8 "Big load" 3000 1 3 $null "No"
    SetName "SystemVoltsSel" 12
    $excel.CalculateFull()
    Check "Forced 12V warning present" ([int]((N "WarningCount") -gt 0)) 1
    SetName "SystemVoltsSel" "auto"
}
finally {
    if ($wb) { $wb.Close($false) }
    $excel.Quit()
    foreach ($o in @($inputs, $wb, $excel)) { if ($o) { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($o) } }
    [GC]::Collect(); [GC]::WaitForPendingFinalizers()
}
Write-Output ("RESULT: {0} passed, {1} failed" -f $script:pass, $script:fail)
if ($script:fail -gt 0) { exit 1 }
