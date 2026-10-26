param([Parameter(Mandatory)][string]$OutFile)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
try {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $pr = New-Object Security.Principal.WindowsPrincipal($id)
    $admin = $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    Write-Result -OutFile $OutFile -Data @{ elevated = [bool]$admin; user = [string]$id.Name }
} catch {
    Write-Result -OutFile $OutFile -ErrorMessage $_.Exception.Message
}
