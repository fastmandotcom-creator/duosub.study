<#
.SYNOPSIS
Authenticode-sign the Windows MSI and NSIS installer produced by Tauri.

Requires a base64-encoded PFX (WINDOWS_PFX_BASE64) and its password (WINDOWS_PFX_PASSWORD).
Refuses to run without them: an unsigned installer is not a releasable artifact.
#>
param(
    [Parameter(Mandatory = $true)]
    [string[]]$Artifacts,
    [string]$PfxBase64 = $env:WINDOWS_PFX_BASE64,
    [string]$PfxPassword = $env:WINDOWS_PFX_PASSWORD
)

if ([string]::IsNullOrWhiteSpace($PfxBase64)) {
    throw "WINDOWS_PFX_BASE64 is empty — refusing to publish an unsigned Windows installer."
}
if ([string]::IsNullOrWhiteSpace($PfxPassword)) {
    throw "WINDOWS_PFX_PASSWORD is empty — refusing to publish an unsigned Windows installer."
}

$pfx = Join-Path $env:TEMP "duosub-signing.pfx"
[System.IO.File]::WriteAllBytes($pfx, [Convert]::FromBase64String($PfxBase64))

try {
    $signtool = $null
    $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path $vswhere) {
        $vsDir = & $vswhere -latest -products * -requires Microsoft.Component.MSBuild -property installationPath
        if ($vsDir) {
            $signtool = Get-ChildItem -Path $vsDir -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
                Select-Object -First 1 -ExpandProperty FullName
        }
    }
    if (-not $signtool) {
        $signtool = (Get-Command signtool.exe -ErrorAction Stop).Source
    }

    foreach ($artifact in $Artifacts) {
        if (-not (Test-Path -LiteralPath $artifact)) {
            throw "Artifact not found: $artifact"
        }
        & $signtool sign /fd SHA256 /f $pfx /p $PfxPassword `
            /tr http://timestamp.digicert.com /td SHA256 $artifact
        if ($LASTEXITCODE -ne 0) {
            throw "Authenticode signing failed for $artifact"
        }
        Write-Host "Signed $artifact"
    }
}
finally {
    Remove-Item -LiteralPath $pfx -Force -ErrorAction SilentlyContinue
}
