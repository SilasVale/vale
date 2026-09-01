# ---------------------------------------------------------------------------------------------
#   Copyright (c) Microsoft Corporation. All rights reserved.
#   Licensed under the MIT License. See License.txt in the project root for license information.
# ---------------------------------------------------------------------------------------------
# Vale adaptation: transplanted from microsoft/vscode@main
# (src/vs/workbench/contrib/terminal/common/scripts/shellIntegration.ps1), trimmed to the
# OSC 633 command-boundary core (A/B/C/D/E + P;IsWindows) and namespaced under __VALE.
# The sequences are consumed by vale-agent's exec-marker scanner (find_exec_end_marker /
# shell-integration.rs); the panel renders them as invisible control sequences — no
# wrapper text ever reaches the user's screen.

# Prevent installing more than once per session
if ((Test-Path variable:global:__ValeState) -and $null -ne $Global:__ValeState.OriginalPrompt) {
	return;
}

# Disable shell integration when the language mode is restricted
if ($ExecutionContext.SessionState.LanguageMode -ne "FullLanguage") {
	return;
}

$Global:__ValeState = @{
	OriginalPrompt = $function:Prompt
	LastHistoryId = -1
	IsInExecution = $false
	Nonce = $null
	IsWindows10 = $false
}

# Store the nonce in a regular variable and unset the environment variable.
$Global:__ValeState.Nonce = $env:VALE_NONCE
$env:VALE_NONCE = $null

$osVersion = [System.Environment]::OSVersion.Version
$Global:__ValeState.IsWindows10 = $IsWindows -and $osVersion.Major -eq 10 -and $osVersion.Minor -eq 0 -and $osVersion.Build -lt 22000
Remove-Variable -Name osVersion -ErrorAction SilentlyContinue

function Global:__Vale-Escape-Value([string]$value) {
	# Replace any non-alphanumeric characters.
	[regex]::Replace($value, "[$([char]0x00)-$([char]0x1f)\\\n;]", { param($match)
			# Encode the (ascii) matches as `\x<hex>`
			-Join (
				[System.Text.Encoding]::UTF8.GetBytes($match.Value) | ForEach-Object { '\x{0:x2}' -f $_ }
			)
		})
}

function Global:Prompt() {
	$FakeCode = [int]!$global:?
	Set-StrictMode -Off
	$LastHistoryEntry = Get-History -Count 1
	$Result = ""
	# Skip finishing the command if the first command has not yet started or an execution has not
	# yet begun
	if ($Global:__ValeState.LastHistoryId -ne -1 -and ($Global:__ValeState.HasPSReadLine -eq $false -or $Global:__ValeState.IsInExecution -eq $true)) {
		$Global:__ValeState.IsInExecution = $false
		if ($LastHistoryEntry.Id -eq $Global:__ValeState.LastHistoryId) {
			# Don't provide a command line or exit code if there was no history entry (eg. ctrl+c, enter on no command)
			$Result += "$([char]0x1b)]633;D`a"
		}
		else {
			# Command finished exit code
			# OSC 633 ; D [; <ExitCode>] ST
			$Result += "$([char]0x1b)]633;D;$FakeCode`a"
		}
	}
	# Prompt started
	# OSC 633 ; A ST
	$Result += "$([char]0x1b)]633;A`a"
	# Before running the original prompt, put $? back to what it was:
	if ($FakeCode -ne 0) {
		Write-Error "failure" -ea ignore
	}
	# Run the original prompt
	$OriginalPrompt += $Global:__ValeState.OriginalPrompt.Invoke()
	$Result += $OriginalPrompt

	# Write command started
	$Result += "$([char]0x1b)]633;B`a"
	$Global:__ValeState.LastHistoryId = $LastHistoryEntry.Id
	return $Result
}

# Only send the command executed sequence when PSReadLine is loaded, if not shell integration
# should still work thanks to the command line sequence
$Global:__ValeState.HasPSReadLine = $false
if (Get-Module -Name PSReadLine) {
	$Global:__ValeState.HasPSReadLine = $true
	[Console]::Write("$([char]0x1b)]633;P;HasRichCommandDetection=True`a")

	$Global:__ValeState.OriginalPSConsoleHostReadLine = $function:PSConsoleHostReadLine
	function Global:PSConsoleHostReadLine {
		$CommandLine = $Global:__ValeState.OriginalPSConsoleHostReadLine.Invoke()
		$Global:__ValeState.IsInExecution = $true

		# Command line
		# OSC 633 ; E [; <CommandLine> [; <Nonce>]] ST
		$Result = "$([char]0x1b)]633;E;"
		$Result += $(__Vale-Escape-Value $CommandLine)
		# Only send the nonce if the OS is not Windows 10 as it seems to echo to the terminal
		# sometimes
		if ($Global:__ValeState.IsWindows10 -eq $false) {
			$Result += ";$($Global:__ValeState.Nonce)"
		}
		$Result += "`a"

		# Command executed
		# OSC 633 ; C ST
		$Result += "$([char]0x1b)]633;C`a"

		# Write command executed sequence directly to Console to avoid the new line from Write-Host
		[Console]::Write($Result)

		$CommandLine
	}

	# Set ContinuationPrompt property
	$Global:__ValeState.ContinuationPrompt = (Get-PSReadLineOption).ContinuationPrompt
	if ($Global:__ValeState.ContinuationPrompt) {
		[Console]::Write("$([char]0x1b)]633;P;ContinuationPrompt=$(__Vale-Escape-Value $Global:__ValeState.ContinuationPrompt)`a")
	}
}

# Set IsWindows property
if ($PSVersionTable.PSVersion -lt "6.0") {
	# Windows PowerShell is only available on Windows
	[Console]::Write("$([char]0x1b)]633;P;IsWindows=$true`a")
}
else {
	[Console]::Write("$([char]0x1b)]633;P;IsWindows=$IsWindows`a")
}
