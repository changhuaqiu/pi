param(
	[Parameter(Mandatory = $true)]
	[string] $Payload
)

$ErrorActionPreference = "Stop"
$utf8 = New-Object Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class LogosAgentJob {
	[StructLayout(LayoutKind.Sequential)]
	public struct IoCounters {
		public ulong ReadOperationCount;
		public ulong WriteOperationCount;
		public ulong OtherOperationCount;
		public ulong ReadTransferCount;
		public ulong WriteTransferCount;
		public ulong OtherTransferCount;
	}

	[StructLayout(LayoutKind.Sequential)]
	public struct BasicLimitInformation {
		public long PerProcessUserTimeLimit;
		public long PerJobUserTimeLimit;
		public uint LimitFlags;
		public UIntPtr MinimumWorkingSetSize;
		public UIntPtr MaximumWorkingSetSize;
		public uint ActiveProcessLimit;
		public UIntPtr Affinity;
		public uint PriorityClass;
		public uint SchedulingClass;
	}

	[StructLayout(LayoutKind.Sequential)]
	public struct ExtendedLimitInformation {
		public BasicLimitInformation BasicLimitInformation;
		public IoCounters IoInfo;
		public UIntPtr ProcessMemoryLimit;
		public UIntPtr JobMemoryLimit;
		public UIntPtr PeakProcessMemoryUsed;
		public UIntPtr PeakJobMemoryUsed;
	}

	[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
	public static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);

	[DllImport("kernel32.dll", SetLastError = true)]
	public static extern bool SetInformationJobObject(
		IntPtr job,
		int informationClass,
		IntPtr information,
		uint informationLength
	);

	[DllImport("kernel32.dll", SetLastError = true)]
	public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

	[DllImport("kernel32.dll", SetLastError = true)]
	public static extern bool CloseHandle(IntPtr handle);
}
"@

$job = [LogosAgentJob]::CreateJobObject([IntPtr]::Zero, $null)
if ($job -eq [IntPtr]::Zero) {
	throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())
}

$process = $null
$wrapperAssigned = $false
$exitCode = 1
try {
	$limit = New-Object LogosAgentJob+ExtendedLimitInformation
	$limit.BasicLimitInformation.LimitFlags = 0x00002000
	$length = [Runtime.InteropServices.Marshal]::SizeOf($limit)
	$pointer = [Runtime.InteropServices.Marshal]::AllocHGlobal($length)
	try {
		[Runtime.InteropServices.Marshal]::StructureToPtr($limit, $pointer, $false)
		if (-not [LogosAgentJob]::SetInformationJobObject($job, 9, $pointer, $length)) {
			throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())
		}
	}
	finally {
		[Runtime.InteropServices.Marshal]::FreeHGlobal($pointer)
	}

	$currentProcess = [Diagnostics.Process]::GetCurrentProcess()
	if (-not [LogosAgentJob]::AssignProcessToJobObject($job, $currentProcess.Handle)) {
		throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())
	}
	$wrapperAssigned = $true

	$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload))
	$config = ConvertFrom-Json $json
	$startInfo = New-Object Diagnostics.ProcessStartInfo
	$startInfo.FileName = [string] $config.command
	$startInfo.Arguments = [string] $config.arguments
	$startInfo.WorkingDirectory = [string] $config.cwd
	$startInfo.UseShellExecute = $false
	$startInfo.CreateNoWindow = $true
	$startInfo.RedirectStandardOutput = $true
	$startInfo.RedirectStandardError = $true
	$startInfo.StandardOutputEncoding = $utf8
	$startInfo.StandardErrorEncoding = $utf8
	$startInfo.EnvironmentVariables.Clear()
	foreach ($property in $config.environment.psobject.Properties) {
		$startInfo.EnvironmentVariables[$property.Name] = [string] $property.Value
	}

	$process = New-Object Diagnostics.Process
	$process.StartInfo = $startInfo
	if (-not $process.Start()) {
		throw "Failed to start the fixed task process"
	}

	$stdout = $process.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())
	$stderr = $process.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())
	$process.WaitForExit()
	$stdout.GetAwaiter().GetResult()
	$stderr.GetAwaiter().GetResult()
	$exitCode = $process.ExitCode
}
finally {
	if ($null -ne $process -and -not $process.HasExited) {
		$process.Kill()
	}
	if (-not $wrapperAssigned) {
		[void] [LogosAgentJob]::CloseHandle($job)
	}
}

# The wrapper owns the final Job handle. Process exit closes it and terminates any
# descendants that outlived the fixed task.
exit $exitCode
