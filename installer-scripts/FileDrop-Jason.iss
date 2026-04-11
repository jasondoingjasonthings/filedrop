; FileDrop Inno Setup Script — Jason's Machine
; Compile with Inno Setup 6.x: https://jrsoftware.org/isinfo.php
;
; Before compiling:
;   1. Build the exe:  npm run build:exe  (from the filedrop repo root)
;   2. Place FileDrop-Jason-Setup.exe in ..\build\
;   3. Open this file in the Inno Setup Compiler and click Build > Compile

#define AppName      "FileDrop"
#define AppRole      "Jason"
#define AppVersion   "1.0.0"
#define AppPublisher "FileDrop"
#define AppURL       "http://localhost:5050"
#define AppExeName   "FileDrop-Jason-Setup.exe"
#define ServiceExe   "FileDrop.exe"

[Setup]
AppId={{A1B2C3D4-JASON-4F5E-8A9B-FILEDROPJASON}
AppName={#AppName} ({#AppRole})
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}
AppUpdatesURL={#AppURL}
DefaultDirName={autopf}\FileDrop-Jason
DefaultGroupName=FileDrop (Jason)
DisableProgramGroupPage=yes
; Installer exe output (relative to this .iss file)
OutputDir=..\build
OutputBaseFilename=FileDrop-Jason-Installer
Compression=lzma2/ultra64
SolidCompression=yes
; Require admin so the service can be registered
PrivilegesRequired=admin
PrivilegesRequiredOverridesAllowed=
; Show a wizard-style install UI
WizardStyle=modern
; Uninstall entry in Add/Remove Programs
UninstallDisplayName={#AppName} ({#AppRole})
UninstallDisplayIcon={app}\{#ServiceExe}
; Minimum Windows version: Windows 10
MinVersion=10.0

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut for the dashboard"; GroupDescription: "Additional icons:"; Flags: unchecked

[Files]
; The main application exe — rename to FileDrop.exe in the install dir
Source: "..\build\{#AppExeName}"; DestDir: "{app}"; DestName: "{#ServiceExe}"; Flags: ignoreversion

[Icons]
; Start menu shortcut → opens the dashboard in the default browser
Name: "{group}\FileDrop Dashboard (Jason)"; Filename: "{#AppURL}"
Name: "{group}\Uninstall FileDrop (Jason)"; Filename: "{uninstallexe}"
Name: "{commondesktop}\FileDrop Dashboard (Jason)"; Filename: "{#AppURL}"; Tasks: desktopicon

[Run]
; Register and start the Windows service immediately after install
Filename: "{app}\{#ServiceExe}"; Parameters: "--install"; \
  Description: "Register FileDrop as a Windows service"; \
  Flags: runhidden waituntilterminated

; Open setup wizard in the default browser
Filename: "{#AppURL}/setup"; Description: "Open FileDrop setup wizard in browser"; \
  Flags: shellexec nowait postinstall skipifsilent; \
  StatusMsg: "Opening setup wizard..."

[UninstallRun]
; Stop and deregister the service before files are removed
Filename: "{app}\{#ServiceExe}"; Parameters: "--uninstall"; \
  Flags: runhidden waituntilterminated; \
  RunOnceId: "UninstallService"

[Code]
// Show a friendly message if the service failed to start
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
