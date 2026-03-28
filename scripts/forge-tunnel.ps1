# Forge Reverse SSH Tunnel — keeps a persistent tunnel to the Linux server
# so the server can always reach this Windows PC via: ssh -p 2222 zbonham@localhost
#
# Runs as a scheduled task on boot. Auto-reconnects on failure.

$ServerHost = "192.168.12.111"
$ServerUser = "zbonham"
$TunnelPort = 2222
$LocalPort = 22
$RetrySeconds = 30

while ($true) {
    Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Starting reverse tunnel to ${ServerUser}@${ServerHost}..."

    $process = Start-Process -FilePath "ssh" -ArgumentList @(
        "-R", "${TunnelPort}:localhost:${LocalPort}",
        "-N",
        "-o", "ServerAliveInterval=60",
        "-o", "ServerAliveCountMax=3",
        "-o", "ExitOnForwardFailure=yes",
        "-o", "StrictHostKeyChecking=no",
        "${ServerUser}@${ServerHost}"
    ) -NoNewWindow -PassThru -Wait

    Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Tunnel exited (code $($process.ExitCode)). Retrying in ${RetrySeconds}s..."
    Start-Sleep -Seconds $RetrySeconds
}
