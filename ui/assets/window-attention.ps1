param([switch]$CheckOnly, [switch]$SelfTest)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Web.Extensions
Add-Type -Path (Join-Path $PSScriptRoot 'window-attention.cs') -ReferencedAssemblies System.Windows.Forms,System.Drawing,System.Web.Extensions
if ($CheckOnly) { Write-Output 'Window attention helper compiled successfully'; exit 0 }
if ($SelfTest) { [CodexWindowAttention]::SelfTest(); exit 0 }
[CodexWindowAttention]::Run()
