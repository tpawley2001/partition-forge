param(
    [Parameter(Mandatory)][string]$OutFile,
    [Parameter(Mandatory)][int]$DiskNumber,
    [Parameter(Mandatory)][int]$PartitionNumber
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')

# Kept out of enumerate.ps1 on purpose: Windows works the limits out by
# analysing the volume's free-space layout, which takes 25-30 s per large NTFS
# volume. Asking for one partition when it is about to be resized keeps the
# disk list fast.
try {
    $ss = Get-PartitionSupportedSize -DiskNumber $DiskNumber -PartitionNumber $PartitionNumber -ErrorAction Stop
    Write-Result -OutFile $OutFile -Data @{ sizeMin = [int64]$ss.SizeMin; sizeMax = [int64]$ss.SizeMax }
} catch {
    # Not an error for the caller: no reported limits means "online resize not
    # supported", which the planner already handles by staging offline.
    Write-Result -OutFile $OutFile -Data @{ sizeMin = $null; sizeMax = $null }
}
