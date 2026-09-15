; ─── Lumin 安装器自定义段（通过 electron-builder.yml 的 nsis.include 挂上）──────────
; 这个文件是**唯一**放 NSIS 自定义逻辑的地方。里面每段都写清「为什么必须有它」，
; 因为这些行为在安装器里看不见，只有卸载后查注册表才会暴露（见 docs/packaging-install-test.md）。

; ── 工具宏：把某个扩展名上的关联残留清干净 ──
; 上游的 APP_UNASSOCIATE（app-builder-lib/templates/nsis/include/FileAssociation.nsh:99）
; 只做两件事：删 `<ext>\OpenWithProgids` 里的 ProgID 值、删 ProgID 子树。
; 它**不删扩展名自身的默认值**，而安装时的 APP_ASSOCIATE 恰恰往那里写了 ProgID
; （同文件 :66 → `WriteRegStr SHELL_CONTEXT "Software\Classes\.${EXT}" "" "${FILECLASS}"`）。
; 于是卸载后 `HKCU\Software\Classes\.md` 仍写着 "Markdown"，指向一个已经被删除的 ProgID ——
; 这就是「悬空关联」：用户之后双击 .md 会落到「选择打开方式」，而不是回退到卸载前的默认程序。
; 实测证据与复现步骤见 docs/packaging-install-test.md 的 P1。
;
; 用 SHELL_CONTEXT 而不是写死 HKCU/HKLM：它由安装模式（per-user / per-machine）决定，
; 写死会让全机安装的机器上留下另一套残留。
!macro Lumin_UnassociateExtension EXT
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.${EXT}" ""
  DeleteRegKey /ifempty SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids"
  DeleteRegKey /ifempty SHELL_CONTEXT "Software\Classes\.${EXT}"
!macroend

; ── 安装完成后 ──
!macro customInstall
  ; 「设置 → 应用 → 已安装的应用」里的「安装位置」一栏。
  ; electron-builder 只把 InstallLocation 写进 INSTALL_REGISTRY_KEY（Software\<APP_GUID>，用于
  ; 重复安装检测），没写进卸载键 UNINSTALL_REGISTRY_KEY，所以那一栏在实测里是空的（见 P6）。
  ; !ifdef 守卫：万一上游改了这两个定义，脚本仍然能编译，只是不做这件事。
  !ifdef UNINSTALL_REGISTRY_KEY
    WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "InstallLocation" "$INSTDIR"
  !endif
!macroend

; ── 卸载收尾 ──
!macro customUnInstall
  ; .md / .markdown 与 electron-builder.yml 的 fileAssociations 一一对应；改一处要改两处。
  !insertmacro Lumin_UnassociateExtension "md"
  !insertmacro Lumin_UnassociateExtension "markdown"

  ; 主动通知 shell「文件关联变了」，让资源管理器与「打开方式」列表立刻刷新，
  ; 而不必等用户注销或重启资源管理器。常量与宏都是 FileAssociation.nsh 提供的
  ; （electron-builder 因为配了 fileAssociations 才会 include 它），用 !ifmacrodef 守卫以免将来变化。
  !ifmacrodef UPDATEFILEASSOC
    !insertmacro UPDATEFILEASSOC
  !endif
!macroend
