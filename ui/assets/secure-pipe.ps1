param([ValidateSet('Key', 'Serve')][string]$Mode, [string]$Storage, [string]$Pipe)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  Add-Type -AssemblyName System.Web.Extensions
  Add-Type -Path (Join-Path $PSScriptRoot 'secure-pipe.cs') -ReferencedAssemblies System.Web.Extensions,System.Security
  if ($Mode -eq 'Key') { [Console]::WriteLine([CodexSecurePipe]::ReadKey($Storage)); exit 0 }
  [CodexSecurePipe]::Run($Pipe)
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
