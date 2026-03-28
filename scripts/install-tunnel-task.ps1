# Install the Forge reverse tunnel as a Windows Scheduled Task
# Run this script as Administrator once.

$TaskName = "Forge-ReverseTunnel"
$ScriptPath = Join-Path $PSScriptRoot "forge-tunnel.ps1"

# Remove existing task if present
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

$Action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ScriptPath`""

$Trigger = New-ScheduledTaskTrigger -AtLogon -User $env:USERNAME

$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Days 365)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Description "Forge reverse SSH tunnel to Linux server for Telegram bot deploy access" `
    -RunLevel Highest

Write-Host "Scheduled task '$TaskName' created."
Write-Host "It will start the tunnel at every logon."
Write-Host ""
Write-Host "To start it now:"
Write-Host "  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host ""
Write-Host "To check status:"
Write-Host "  Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
