# Shared helpers dot-sourced by every PartitionForge script.

function Write-Result {
    param(
        [Parameter(Mandatory)][string]$OutFile,
        $Data = $null,
        [string]$ErrorMessage = ''
    )
    $envelope = @{
        ok    = [string]::IsNullOrEmpty($ErrorMessage)
        data  = $Data
        error = $ErrorMessage
    }
    $json = $envelope | ConvertTo-Json -Depth 10 -Compress
    # UTF8Encoding($false) => no BOM. WriteAllText avoids the pipeline, so the
    # payload is never line-wrapped by the formatter.
    [System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Write-Progress-Line {
    param([int]$Percent, [string]$Message)
    Write-Host ("PROGRESS {0} {1}" -f $Percent, $Message)
}

# Get-Partition surfaces an empty drive letter as the NUL character, not $null.
function Get-LetterOrNull {
    param($Letter)
    $s = [string]$Letter
    if ([string]::IsNullOrWhiteSpace($s) -or $s -eq [string][char]0) { return $null }
    return $s.Trim()
}
