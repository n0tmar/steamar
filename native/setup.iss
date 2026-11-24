; SteaMar's installer: what the download page offers somebody who has never had the app.
; tools/portable.js stages the folder and compiles this file (npm run package); it is not compiled by
; hand. Updates after the first install still arrive as the zip, through the app's own updater.
;
; Per person, with no administrator prompt: the updater copies a new release over this folder, so it
; has to be a folder the person can write to.

#ifndef Stage
  #error Build this through tools/portable.js --setup, which passes the staged folder and the version.
#endif

[Setup]
; Never change AppId. Windows matches a later install to this one by it, and src/update-apply.js
; uses it to keep the version in Windows' list of installed apps current.
AppId={{442375EF-34EA-4AB5-AEFB-FC35055A87A4}
AppName=SteaMar
AppVersion={#AppVersion}
AppPublisher=SteaMar
AppPublisherURL=https://steamar.cc
AppSupportURL=https://steamar.cc
DefaultDirName={localappdata}\Programs\SteaMar
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; WebView2, which draws the window, needs Windows 10 or newer.
MinVersion=10.0
; The window holds this mutex, so setup and the uninstaller wait until SteaMar is closed.
AppMutex=SteaMar.SingleInstance
UninstallDisplayName=SteaMar
UninstallDisplayIcon={app}\SteaMar.exe
SetupIconFile=assets\steamar.ico
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes

[Tasks]
Name: desktopicon; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
; Everything the release staged except the person's own: out\ is theirs, and config\steam.json is
; handled by the two lines after this one.
Source: "{#Stage}\*"; DestDir: "{app}"; Excludes: "\out,\config\steam.json"; Flags: ignoreversion recursesubdirs createallsubdirs
; A first install takes the release's config as it is. An install over an existing copy takes the
; release's half (the service and its key) and keeps the person's (where Steam is), by the rule the
; updater follows: src\update-apply.js --config, run below.
Source: "{#Stage}\config\steam.json"; DestDir: "{app}\config"; Flags: onlyifdoesntexist uninsneveruninstall
Source: "{#Stage}\config\steam.json"; DestDir: "{tmp}"; Flags: deleteafterinstall

[Icons]
; The id the window sets for itself, so a pinned shortcut and the running window are one taskbar button.
Name: "{autoprograms}\SteaMar"; Filename: "{app}\SteaMar.exe"; WorkingDir: "{app}"; AppUserModelID: "SteaMar.App"
Name: "{autodesktop}\SteaMar"; Filename: "{app}\SteaMar.exe"; WorkingDir: "{app}"; AppUserModelID: "SteaMar.App"; Tasks: desktopicon

[Run]
Filename: "{app}\runtime\node.exe"; Parameters: """{app}\src\update-apply.js"" --config ""{tmp}\steam.json"""; WorkingDir: "{app}"; Flags: runhidden
Filename: "{app}\SteaMar.exe"; Description: "{cm:LaunchProgram,SteaMar}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; The uninstaller only knows the files it put here. Updates add and replace files, and the app fetches
; helper files and data into its own folder, so the program's folders go whole.
Type: filesandordirs; Name: "{app}\ui"
Type: filesandordirs; Name: "{app}\src"
Type: filesandordirs; Name: "{app}\tools"
Type: filesandordirs; Name: "{app}\runtime"
Type: filesandordirs; Name: "{app}\vendor"
Type: filesandordirs; Name: "{app}\data"
Type: filesandordirs; Name: "{app}\ManifestHub"
Type: filesandordirs; Name: "{app}\ManifestHub3"
Type: filesandordirs; Name: "{app}\steamtools-games"
; Caches. The rest of out\ stays: this computer's device key, the backups of the person's game
; scripts, their Steam folders in config\steam.json and the logs are theirs, and a reinstall finds them.
; So does the window's WebView2 profile in %LOCALAPPDATA%\SteaMar, which every copy on the PC shares.
Type: filesandordirs; Name: "{app}\out\api"
Type: filesandordirs; Name: "{app}\out\cache"
Type: filesandordirs; Name: "{app}\out\imgcache"
Type: filesandordirs; Name: "{app}\out\download"
Type: filesandordirs; Name: "{app}\out\update"
Type: filesandordirs; Name: "{app}\out\webview"
