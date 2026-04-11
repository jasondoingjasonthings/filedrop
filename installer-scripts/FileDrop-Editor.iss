; FileDrop Inno Setup Script — Editor's Machine
; Compile with Inno Setup 6.x: https://jrsoftware.org/isinfo.php
;
; Before compiling:
;   1. Build the exe:  npm run build:exe  (from the filedrop repo root)
;   2. Place FileDrop-Editor-Setup.exe in ..\build\
;   3. Open this file in the Inno Setup Compiler and click Build > Compile

#define AppName      "FileDrop"
#define AppRole      "Editor"
#define AppVersion   "1.0.0"
#define AppPublisher "FileDrop"
#define AppURL       "http://localhost:5050"
#define AppExeName   "FileDrop-Editor-Setup.exe"
#define ServiceExe   "FileDrop.exe"

[Setup]
AppId={{B2C3D4E5-EDIT-4F5E-8A9B-FILEDROPEDTR}
AppName={#AppName} ({#AppRole})
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}
AppUpdatesURL={#AppURL}
DefaultDirName={autopf}\FileDrop-Editor
DefaultGroupName=FileDrop (Editor)
DisableProgramGroupPage=yes
OutputDir=..\build
OutputBaseFilename=FileDrop-Editor-Installer
Compression=lzma2/ultra64
SolidCompression=yes
PrivilegesRequired=admin
PrivilegesRequiredOverridesAllowed=
WizardStyle=modern
UninstallDisplayName={#AppName} ({#AppRole})
UninstallDisplayIcon={app}\{#ServiceExe}
MinVersion=10.0

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut for the dashboard"; GroupDescription: "Additional icons:"; Flags: unchecked

[Files]
Source: "..\build\{#AppExeName}"; DestDir: "{app}"; DestName: "{#ServiceExe}"; Flags: ignoreversion

[Icons]
Name: "{group}\FileDrop Dashboard (Editor)"; Filename: "{#AppURL}"
Name: "{group}\Uninstall FileDrop (Editor)"; Filename: "{uninstallexe}"
Name: "{commondesktop}\FileDrop Dashboard (Editor)"; Filename: "{#AppURL}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#ServiceExe}"; Parameters: "--install"; \
  Description: "Register FileDrop as a Windows service"; \
  Flags: runhidden waituntilterminated

Filename: "{#AppURL}/setup"; Description: "Open FileDrop setup wizard in browser"; \
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
  begin
    MsgBox(
      'FileDrop has been installed and the background service has been started.' + #13#10 + #13#10 +
      'Your browser will open the setup wizard at http://localhost:5050/setup.' + #13#10 + #13#10 +
      'Create your owner account and configure your folders to complete setup.',
      mbInformation,
      MB_OK
    );
  end;
end;
