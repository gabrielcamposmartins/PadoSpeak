; Ganchos do instalador NSIS do PadoSpeak.
; Desinstalar tira o PadoSpeak da inicialização do Windows (o app recoloca ao abrir, se a pessoa quiser).
!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "PadoSpeak"
!macroend
