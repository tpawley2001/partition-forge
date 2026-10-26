param([Parameter(Mandatory)][string]$OutFile)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')

try {
    # MediaType (SSD/HDD) lives on MSFT_PhysicalDisk, keyed by DeviceId == disk number.
    $phys = @{}
    try {
        foreach ($pd in (Get-PhysicalDisk -ErrorAction Stop)) { $phys[[string]$pd.DeviceId] = $pd }
    } catch { }

    $disks = New-Object System.Collections.ArrayList

    foreach ($d in (Get-Disk | Sort-Object Number)) {
        $parts = New-Object System.Collections.ArrayList
        $plist = @()
        try { $plist = @(Get-Partition -DiskNumber $d.Number -ErrorAction Stop | Sort-Object Offset) } catch { }

        foreach ($p in $plist) {
            $volObj = $null
            try {
                $v = $p | Get-Volume -ErrorAction Stop
                if ($null -ne $v) {
                    $volObj = @{
                        fileSystem    = [string]$v.FileSystem
                        label         = [string]$v.FileSystemLabel
                        size          = [int64]$v.Size
                        sizeRemaining = [int64]$v.SizeRemaining
                        health        = [string]$v.HealthStatus
                        uniqueId      = [string]$v.UniqueId
                    }
                }
            } catch { }

            $gpt = $null; $mbr = $null
            if ($d.PartitionStyle -eq 'GPT') { $gpt = [string]$p.GptType }
            elseif ($d.PartitionStyle -eq 'MBR') { try { $mbr = [int]$p.MbrType } catch { } }

            [void]$parts.Add(@{
                diskNumber       = [int]$d.Number
                partitionNumber  = [int]$p.PartitionNumber
                driveLetter      = (Get-LetterOrNull $p.DriveLetter)
                offset           = [int64]$p.Offset
                size             = [int64]$p.Size
                typeName         = [string]$p.Type
                gptType          = $gpt
                mbrType          = $mbr
                isBoot           = [bool]$p.IsBoot
                isSystem         = [bool]$p.IsSystem
                isActive         = [bool]$p.IsActive
                isHidden         = [bool]$p.IsHidden
                guid             = [string]$p.Guid
                volume           = $volObj
                # Filled in per partition by supported-size.ps1; querying them
                # here cost ~30 s per large NTFS volume.
                supportedSizeMin = $null
                supportedSizeMax = $null
            })
        }

        # Identity that survives the reboot into the offline engine.
        $diskGuid = $null; $diskSig = $null
        if ($d.PartitionStyle -eq 'GPT') {
            $g = [string]$d.Guid
            if (-not [string]::IsNullOrWhiteSpace($g)) { $diskGuid = $g.Trim('{','}').ToLower() }
        } elseif ($d.PartitionStyle -eq 'MBR') {
            try { $diskSig = ('{0:x8}' -f [uint32]$d.Signature) } catch { }
        }

        $mediaType = 'Unspecified'
        $key = [string]$d.Number
        if ($phys.ContainsKey($key)) { $mediaType = [string]$phys[$key].MediaType }

        [void]$disks.Add(@{
            number             = [int]$d.Number
            friendlyName       = [string]$d.FriendlyName
            serialNumber       = ([string]$d.SerialNumber).Trim()
            size               = [int64]$d.Size
            partitionStyle     = [string]$d.PartitionStyle
            busType            = [string]$d.BusType
            mediaType          = $mediaType
            sectorSize         = [int]$d.LogicalSectorSize
            physicalSectorSize = [int]$d.PhysicalSectorSize
            isBoot             = [bool]$d.IsBoot
            isSystem           = [bool]$d.IsSystem
            isOffline          = [bool]$d.IsOffline
            isReadOnly         = [bool]$d.IsReadOnly
            health             = [string]$d.HealthStatus
            diskGuid           = $diskGuid
            diskSignature      = $diskSig
            partitions         = @($parts.ToArray())
            free               = @()   # gaps are computed host-side
        })
    }

    Write-Result -OutFile $OutFile -Data @{ disks = @($disks.ToArray()) }
} catch {
    Write-Result -OutFile $OutFile -ErrorMessage $_.Exception.Message
}
