$ErrorActionPreference = 'Continue'
$project = $PSScriptRoot
$logDir = Join-Path $project 'logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logFile = Join-Path $logDir 'server.log'
$nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCmd) { $nodeCmd = Get-Command node -ErrorAction Stop }
$nodePath = $nodeCmd.Source
$serverPath = Join-Path $project 'src\server.js'
while ($true) {
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    "[$stamp] Démarrage de Nexora Indexation..." | Out-File -FilePath $logFile -Append -Encoding utf8
    try {
        & $nodePath $serverPath *>> $logFile
        "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Le serveur s'est arrêté (code $LASTEXITCODE). Redémarrage dans 5 secondes." | Out-File -FilePath $logFile -Append -Encoding utf8
    } catch {
        "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Erreur : $_" | Out-File -FilePath $logFile -Append -Encoding utf8
    }
    Start-Sleep -Seconds 5
}
