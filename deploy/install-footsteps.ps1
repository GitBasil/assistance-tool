# One-time + update install for Footsteps (assistance-tool) on this Windows server.
# Expects the deploy tarball at C:\apps\footsteps-deploy.tgz containing:
#   package.json, build/, dist/, bridge/dashboard/
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File C:\apps\install-footsteps.ps1
#   powershell -ExecutionPolicy Bypass -File C:\apps\install-footsteps.ps1 -UpdateOnly

param(
  [switch]$UpdateOnly,
  [string]$Tarball = "C:\apps\footsteps-deploy.tgz",
  [string]$Domain = "ultrainnovate.com",
  [string]$WwwDomain = "www.ultrainnovate.com",
  [int]$Port = 7821
)

$ErrorActionPreference = "Stop"
$appcmd = "$env:windir\System32\inetsrv\appcmd.exe"
$root = "C:\apps\assistance-tool"
$app = Join-Path $root "app"
$data = Join-Path $root "data"
$logs = "C:\logs\assistance-tool"
$iisRoot = Join-Path $root "iis"
$runtime = Join-Path $root "runtime"
$nodeHome = Join-Path $runtime "node"
$nodeExe = Join-Path $nodeHome "node.exe"
$nssm = "C:\apps\mechanic-shop\installers\nssm-2.24\win64\nssm.exe"
$svc = "Footsteps"
$siteName = "ultrainnovate.com"
$poolName = "Footsteps"
$startCmd = Join-Path $root "start-footsteps.cmd"

function Write-Step($m) { Write-Output ("== " + $m + " ==") }

Write-Step "directories"
New-Item -ItemType Directory -Force -Path $root,$app,$data,$logs,$iisRoot,$runtime | Out-Null

if (-not (Test-Path $nodeExe)) {
  Write-Step "install portable Node 22"
  $zip = Join-Path $runtime "node-v22.16.0-win-x64.zip"
  $url = "https://nodejs.org/dist/v22.16.0/node-v22.16.0-win-x64.zip"
  if (-not (Test-Path $zip)) {
    Write-Output "Downloading $url"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
  }
  $extract = Join-Path $runtime "node-extract"
  Remove-Item $extract -Recurse -Force -ErrorAction SilentlyContinue
  Expand-Archive -Path $zip -DestinationPath $extract -Force
  $inner = Get-ChildItem $extract -Directory | Select-Object -First 1
  if (-not $inner) { throw "Node zip did not contain a folder" }
  Remove-Item $nodeHome -Recurse -Force -ErrorAction SilentlyContinue
  Move-Item $inner.FullName $nodeHome
  Remove-Item $extract -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Output ("NODE=" + (& $nodeExe -v))

if (-not (Test-Path $Tarball)) { throw "Missing tarball: $Tarball" }

Write-Step "extract app"
$sync = Join-Path $root "_sync"
Remove-Item $sync -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $sync | Out-Null
tar -xzf $Tarball -C $sync
Get-ChildItem $sync -Recurse -Force -Filter "._*" | Remove-Item -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $sync ".DS_Store") -Force -ErrorAction SilentlyContinue

# Mirror into app; keep data outside.
robocopy $sync $app /MIR /XD data /NFL /NDL /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }
Remove-Item $sync -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $Tarball -Force -ErrorAction SilentlyContinue

if (-not (Test-Path (Join-Path $app "build\server.mjs"))) { throw "build\server.mjs missing after extract" }
if (-not (Test-Path (Join-Path $app "dist\assist.js"))) { throw "dist\assist.js missing after extract" }

Write-Step "start script + env"
$envFile = Join-Path $root "footsteps.env.cmd"
@"
@echo off
set ASSIST_HOST=127.0.0.1
set ASSIST_PORT=$Port
set ASSIST_PUBLIC_URL=https://$Domain
set ASSIST_ALLOWED_HOSTS=$Domain,$WwwDomain
set ASSIST_DATA_DIR=$data
set ASSIST_TRUST_PROXY=true
set ASSIST_LOG_LEVEL=info
set ASSIST_LOG_FORMAT=json
set NODE_ENV=production
"@ | Set-Content -Path $envFile -Encoding ASCII

@"
@echo off
call `"$envFile`"
cd /d `"$app`"
`"$nodeExe`" --disable-warning=ExperimentalWarning build\server.mjs
"@ | Set-Content -Path $startCmd -Encoding ASCII

if (-not (Test-Path $nssm)) { throw "nssm not found at $nssm" }

Write-Step "windows service $svc"
$existing = sc.exe query $svc 2>$null
if ($LASTEXITCODE -eq 0) {
  & $nssm stop $svc confirm 2>$null | Out-Null
  Start-Sleep -Seconds 2
  & $nssm set $svc Application $startCmd | Out-Null
  & $nssm set $svc AppDirectory $app | Out-Null
  & $nssm set $svc AppStdout (Join-Path $logs "stdout.log") | Out-Null
  & $nssm set $svc AppStderr (Join-Path $logs "stderr.log") | Out-Null
  & $nssm set $svc AppRotateFiles 1 | Out-Null
  & $nssm set $svc AppRotateBytes 10485760 | Out-Null
  & $nssm set $svc Start SERVICE_AUTO_START | Out-Null
} else {
  & $nssm install $svc $startCmd
  if ($LASTEXITCODE -ne 0) { throw "nssm install failed" }
  & $nssm set $svc AppDirectory $app | Out-Null
  & $nssm set $svc DisplayName "Footsteps (assistance-tool)" | Out-Null
  & $nssm set $svc Description "Footsteps analytics server for $Domain" | Out-Null
  & $nssm set $svc AppStdout (Join-Path $logs "stdout.log") | Out-Null
  & $nssm set $svc AppStderr (Join-Path $logs "stderr.log") | Out-Null
  & $nssm set $svc AppRotateFiles 1 | Out-Null
  & $nssm set $svc AppRotateBytes 10485760 | Out-Null
  & $nssm set $svc AppExit Default Restart | Out-Null
  & $nssm set $svc Start SERVICE_AUTO_START | Out-Null
}

Write-Step "IIS reverse-proxy site"
$webConfig = @"
<?xml version="1.0" encoding="UTF-8"?>
<configuration>
  <system.webServer>
    <rewrite>
      <rules>
        <rule name="FootstepsProxy" stopProcessing="true">
          <match url="(.*)" />
          <action type="Rewrite" url="http://127.0.0.1:$Port/{R:1}" />
          <serverVariables>
            <set name="HTTP_X_FORWARDED_PROTO" value="https" />
            <set name="HTTP_X_FORWARDED_HOST" value="{HTTP_HOST}" />
          </serverVariables>
        </rule>
      </rules>
    </rewrite>
    <httpProtocol>
      <customHeaders>
        <remove name="X-Powered-By" />
        <add name="X-Accel-Buffering" value="no" />
      </customHeaders>
    </httpProtocol>
    <security>
      <requestFiltering>
        <requestLimits maxAllowedContentLength="10485760" />
      </requestFiltering>
    </security>
  </system.webServer>
</configuration>
"@
Set-Content -Path (Join-Path $iisRoot "web.config") -Value $webConfig -Encoding UTF8

# Allow ARR to set forwarded headers (needed once per server; safe if already present).
try {
  & $appcmd set config -section:system.webServer/rewrite/allowedServerVariables /+"[name='HTTP_X_FORWARDED_PROTO']" /commit:apphost | Out-Null
} catch {}
try {
  & $appcmd set config -section:system.webServer/rewrite/allowedServerVariables /+"[name='HTTP_X_FORWARDED_HOST']" /commit:apphost | Out-Null
} catch {}
# responseBufferLimit MUST be 0 or the dashboard EventSource (/api/stream) hangs on
# "Connecting…" — ARR otherwise buffers the SSE response until it "finishes".
& $appcmd set config -section:system.webServer/proxy /enabled:"True" /preserveHostHeader:"True" /reverseRewriteHostInResponseHeaders:"False" /responseBufferLimit:"0" /minResponseBuffer:"0" /commit:apphost | Out-Null

$poolExists = & $appcmd list apppool $poolName 2>$null
if (-not $poolExists) {
  & $appcmd add apppool /name:$poolName /managedRuntimeVersion:"" /startMode:AlwaysRunning | Out-Null
}

$siteExists = & $appcmd list site $siteName 2>$null
$bindings = "https/*:443:$Domain,https/*:443:$WwwDomain"
if (-not $siteExists) {
  & $appcmd add site /name:$siteName /physicalPath:$iisRoot /bindings:$bindings | Out-Null
  & $appcmd set app "$siteName/" /applicationPool:$poolName | Out-Null
} else {
  & $appcmd set vdir "$siteName/" /physicalPath:$iisRoot | Out-Null
  & $appcmd set app "$siteName/" /applicationPool:$poolName | Out-Null
  # Ensure bindings exist
  $current = & $appcmd list site $siteName
  if ($current -notmatch [regex]::Escape($Domain)) {
    & $appcmd set site /site.name:$siteName /+bindings.[protocol='https',bindingInformation="*:443:$Domain"] | Out-Null
  }
  if ($current -notmatch [regex]::Escape($WwwDomain)) {
    & $appcmd set site /site.name:$siteName /+bindings.[protocol='https',bindingInformation="*:443:$WwwDomain"] | Out-Null
  }
}

& $appcmd start apppool $poolName | Out-Null
& $appcmd start site $siteName | Out-Null

Write-Step "start service"
sc.exe start $svc | Out-Null
Start-Sleep -Seconds 4
$state = (sc.exe query $svc | Select-String "STATE").ToString().Trim()
Write-Output $state
if ($state -match "PAUSED") { sc.exe continue $svc | Out-Null; Start-Sleep -Seconds 3 }

Write-Step "local health probe"
$ok = $false
for ($i = 0; $i -lt 20; $i++) {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/ready" -UseBasicParsing -TimeoutSec 2
    if ($r.StatusCode -eq 200) {
      Write-Output ("LOCAL_READY: " + $r.StatusCode + " " + $r.Content)
      $ok = $true
      break
    }
  } catch {
    Start-Sleep -Seconds 1
  }
}
if (-not $ok) {
  Write-Output "---- stderr ----"
  if (Test-Path (Join-Path $logs "stderr.log")) { Get-Content (Join-Path $logs "stderr.log") -Tail 40 }
  Write-Output "---- stdout ----"
  if (Test-Path (Join-Path $logs "stdout.log")) { Get-Content (Join-Path $logs "stdout.log") -Tail 40 }
  throw "Footsteps did not become ready on 127.0.0.1:$Port"
}

Write-Step "IIS host-header probe"
$curl = "$env:SystemRoot\System32\curl.exe"
if (Test-Path $curl) {
  $code = & $curl -sk -o NUL -w "%{http_code}" -H "Host: $Domain" "https://127.0.0.1/ready"
  Write-Output ("IIS_READY_HTTP: " + $code)
  $dash = & $curl -sk -o NUL -w "%{http_code}" -H "Host: $Domain" "https://127.0.0.1/dashboard"
  Write-Output ("IIS_DASHBOARD_HTTP: " + $dash)
  $js = & $curl -sk -o NUL -w "%{http_code}" -H "Host: $Domain" "https://127.0.0.1/assist.js"
  Write-Output ("IIS_ASSIST_JS_HTTP: " + $js)
}

Write-Output "INSTALL_FOOTSTEPS_DONE"
Write-Output ("public: https://$Domain/dashboard")
