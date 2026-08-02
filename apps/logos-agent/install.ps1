$ErrorActionPreference = "Stop"

$appRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $appRoot "..\.."))
$rootManifest = Join-Path $repositoryRoot "package.json"
$appManifest = Join-Path $appRoot "package.json"
$appLockfile = Join-Path $appRoot "package-lock.json"

foreach ($requiredPath in @($rootManifest, $appManifest, $appLockfile)) {
	if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
		throw "Required install input is missing: $requiredPath"
	}
}

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$npmCommand = Get-Command npm -ErrorAction SilentlyContinue
if (-not $nodeCommand -or -not $npmCommand) {
	throw "Node.js 22.19.0+ and npm are required"
}

$nodeVersionText = (& $nodeCommand.Source --version).Trim().TrimStart("v")
if ([version]$nodeVersionText -lt [version]"22.19.0") {
	throw "Node.js 22.19.0+ is required; found $nodeVersionText"
}

function Invoke-NpmCommand {
	param(
		[Parameter(Mandatory = $true)]
		[string]$WorkingDirectory,
		[Parameter(Mandatory = $true)]
		[string[]]$NpmArguments,
		[Parameter(Mandatory = $true)]
		[string]$Label
	)

	Push-Location -LiteralPath $WorkingDirectory
	try {
		& $npmCommand.Source @NpmArguments
		if ($LASTEXITCODE -ne 0) {
			throw "$Label failed with exit code $LASTEXITCODE"
		}
	} finally {
		Pop-Location
	}
}

Invoke-NpmCommand -WorkingDirectory $repositoryRoot -NpmArguments @("ci", "--ignore-scripts") -Label "Repository dependency install"
Invoke-NpmCommand -WorkingDirectory $appRoot -NpmArguments @("ci", "--ignore-scripts") -Label "Logos Agent dependency install"
Invoke-NpmCommand -WorkingDirectory $appRoot -NpmArguments @("link", "--ignore-scripts") -Label "Global logos-agent command registration"

$logosCommand = Get-Command logos-agent -ErrorAction SilentlyContinue
if (-not $logosCommand) {
	throw "logos-agent was linked but is not available on PATH"
}
if (Get-Command learning-agent -ErrorAction SilentlyContinue) {
	Write-Warning "The legacy learning-agent command is still on PATH; remove its previous global npm installation separately."
}

Write-Output "Logos Agent installed: $($logosCommand.Source)"
Write-Output "Optional observability: run npm run observability:install in $appRoot (Python 3.11+ required)."
Write-Output "Optional CodeGraph: install a trusted bundle separately, then set LOGOS_AGENT_CODEGRAPH_PATH when auto-discovery is unavailable."
