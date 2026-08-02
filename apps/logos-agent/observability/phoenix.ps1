param(
	[Parameter(Mandatory = $true, Position = 0)]
	[ValidateSet("install", "start", "status", "stop")]
	[string]$Action
)

$ErrorActionPreference = "Stop"
$observabilityRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.data\observability"))
$venvRoot = Join-Path $observabilityRoot "venv"
$phoenixExecutable = Join-Path $venvRoot "Scripts\phoenix.exe"
$pythonExecutable = Join-Path $venvRoot "Scripts\python.exe"
$dataRoot = Join-Path $observabilityRoot "phoenix-data"
$pidPath = Join-Path $observabilityRoot "phoenix.pid"
$stdoutPath = Join-Path $observabilityRoot "phoenix.stdout.log"
$stderrPath = Join-Path $observabilityRoot "phoenix.stderr.log"
$phoenixVersion = "19.13.0"

function Get-PhoenixProcess {
	if (-not (Test-Path -LiteralPath $pidPath)) { return $null }
	$storedPid = (Get-Content -LiteralPath $pidPath -Raw).Trim()
	if ($storedPid -notmatch "^\d+$") { return $null }
	$process = Get-Process -Id ([int]$storedPid) -ErrorAction SilentlyContinue
	if (-not $process) { return $null }
	if ([System.IO.Path]::GetFullPath($process.Path) -ne [System.IO.Path]::GetFullPath($phoenixExecutable)) {
		throw "Refusing to manage PID $storedPid because it is not the configured Phoenix executable"
	}
	return $process
}

function Get-DescendantProcessIds([int]$RootPid) {
	$allProcesses = @(Get-CimInstance Win32_Process)
	$pending = [System.Collections.Generic.Queue[int]]::new()
	$pending.Enqueue($RootPid)
	$result = [System.Collections.Generic.List[int]]::new()
	while ($pending.Count -gt 0) {
		$parentPid = $pending.Dequeue()
		foreach ($child in $allProcesses | Where-Object { $_.ParentProcessId -eq $parentPid }) {
			$result.Add([int]$child.ProcessId)
			$pending.Enqueue([int]$child.ProcessId)
		}
	}
	return $result
}

function Stop-PhoenixProcess($Process) {
	$descendants = @(Get-DescendantProcessIds $Process.Id)
	[array]::Reverse($descendants)
	foreach ($childPid in $descendants) {
		Stop-Process -Id $childPid -Force -ErrorAction SilentlyContinue
	}
	Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
	Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
}

function Test-PhoenixHealth {
	try {
		$response = Invoke-WebRequest -Uri "http://127.0.0.1:6006" -UseBasicParsing -TimeoutSec 2
		return $response.StatusCode -eq 200
	} catch {
		return $false
	}
}

switch ($Action) {
	"install" {
		New-Item -ItemType Directory -Force -Path $observabilityRoot, $dataRoot | Out-Null
		if (-not (Test-Path -LiteralPath $pythonExecutable)) {
			$systemPython = Get-Command python -ErrorAction SilentlyContinue
			if (-not $systemPython) { throw "Python 3.11+ is required" }
			$pythonVersion = & $systemPython.Source -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
			if ([version]$pythonVersion -lt [version]"3.11") {
				throw "Python 3.11+ is required; found $pythonVersion"
			}
			& $systemPython.Source -m venv $venvRoot
		}
		& $pythonExecutable -m pip install --upgrade "pip==26.2"
		& $pythonExecutable -m pip install "arize-phoenix==$phoenixVersion"
		Write-Output "Phoenix $phoenixVersion installed in $venvRoot"
	}
	"start" {
		if (Test-PhoenixHealth) {
			Write-Output "Phoenix is already running at http://127.0.0.1:6006"
			break
		}
		if (-not (Test-Path -LiteralPath $phoenixExecutable)) {
			throw "Phoenix is not installed. Run: .\phoenix.ps1 install"
		}
		New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
		$env:PHOENIX_WORKING_DIR = $dataRoot
		$env:PHOENIX_PORT = "6006"
		$env:PHOENIX_GRPC_PORT = "4317"
		$process = Start-Process -FilePath $phoenixExecutable -ArgumentList "serve" -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
		Set-Content -LiteralPath $pidPath -Value $process.Id
		for ($attempt = 0; $attempt -lt 30; $attempt++) {
			if (Test-PhoenixHealth) {
				Write-Output "Phoenix started at http://127.0.0.1:6006 (PID $($process.Id))"
				break
			}
			Start-Sleep -Milliseconds 500
		}
		if (-not (Test-PhoenixHealth)) {
			Stop-PhoenixProcess $process
			throw "Phoenix did not become healthy. See $stderrPath"
		}
	}
	"status" {
		$process = Get-PhoenixProcess
		if (Test-PhoenixHealth) {
			$pidLabel = if ($process) { $process.Id } else { "untracked" }
			Write-Output "running pid=$pidLabel ui=http://127.0.0.1:6006 otlp=http://127.0.0.1:6006/v1/traces"
			exit 0
		}
		Write-Output "stopped"
		exit 1
	}
	"stop" {
		$process = Get-PhoenixProcess
		if (-not $process) {
			Write-Output "No tracked Phoenix process is running"
			break
		}
		Stop-PhoenixProcess $process
		Write-Output "Phoenix stopped"
	}
}
