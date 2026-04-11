; FileDrop Inno Setup Script — Spoke (Mitch's PC or any Windows client)
; Compile with Inno Setup 6.x

#define AppName      "FileDrop"
#define AppVersion   "2.0.0"
#define AppPublisher "FileDrop"
#define AppURL       "http://localhost:5050"
#define AppExeName   "FileDrop-Spoke-Setup.exe"
#define ServiceExe   "FileDrop-Spoke.exe"

[Setup]
AppId={{B2C3D4E5-SPOK-4F5E-8A9B-FILEDROPSPOKE}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
DefaultDirName={autopf}\FileDrop
DefaultGroupName=FileDrop
DisableProgramGroupPage=yes
OutputDir=..\build
OutputBaseFilename=FileDrop-Spoke-Installer
Compression=lzma2/ultra64
SolidCompression=yes
PrivilegesRequired=admin
WizardStyle=modern
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\{#ServiceExe}
MinVersion=10.0

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional icons:"; Flags: unchecked

[Files]
Source: "..\build\{#AppExeName}"; DestDir: "{app}"; DestName: "{#ServiceExe}"; Flags: ignoreversion

[Icons]
Name: "{group}\FileDrop Dashboard"; Filename: "{#AppURL}"
Name: "{group}\Uninstall FileDrop"; Filename: "{uninstallexe}"
Name: "{commondesktop}\FileDrop Dashboard"; Filename: "{#AppURL}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#ServiceExe}"; Parameters: "--install"; \
  Description: "Register FileDrop as a Windows service"; \
  Flags: runhidden waituntilterminated

Filename: "{#AppURL}/setup"; Description: "Open FileDrop setup wizard"; \
  Flags: shellexec nowait postinstall skipifsilent; \
  StatusMsg: "Opening setup wizard..."

[UninstallRun]
Filename: "{app}\{#ServiceExe}"; Parameters: "--uninstall"; \
  Flags: runhidden waituntilterminated; \
  RunOnceId: "UninstallService"

[Code]
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    MsgBox(
      'FileDrop installed.' + #13#10 + #13#10 +
      'Your browser will open the setup wizard at http://localhost:5050/setup.' + #13#10 +
      'Select role "Spoke" and enter the hub machine''s Tailscale IP address.',
      mbInformation, MB_OK);
end;
