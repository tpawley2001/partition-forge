; PartitionForge installer customisation.

!macro customInstall
  ; The offline engine is a 64-bit UEFI application. Warn rather than block:
  ; everything Windows can do online still works without it.
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONEXCLAMATION|MB_OK \
      "PartitionForge's offline engine requires 64-bit Windows. The application will install, but operations that need a restart will not be available."
  ${EndIf}
!macroend

!macro customUnInstall
  ; Leave nothing armed in the firmware boot order -- but only on a real
  ; uninstall. An upgrade runs this uninstaller too, and must not disarm work
  ; that is staged for the next restart (the app also refuses to update while
  ; a job is staged).
  ${ifNot} ${isUpdated}
    DetailPrint "Removing any staged PartitionForge boot entry"
    nsExec::ExecToLog 'cmd /c for /f "tokens=2" %i in (^'bcdedit /enum FIRMWARE ^| findstr /i "PartitionForge"^') do bcdedit /delete %i /f'
    Pop $0
  ${endIf}
!macroend
