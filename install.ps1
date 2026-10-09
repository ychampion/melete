# Installs and starts Melete on Windows with Docker Desktop.
#
#   irm https://raw.githubusercontent.com/ychampion/melete/main/install.ps1 | iex
#
# It runs install.sh, from the same branch or tag, in Git Bash, so Windows and
# Linux install the same way. The options are the same environment variables,
# set first with, for example, $env:MELETE_DIR = 'C:\melete'. It returns
# rather than exits, so the PowerShell window running it stays open.

& {
  $ErrorActionPreference = 'Stop'
  $ref = if ($env:MELETE_REF) { $env:MELETE_REF } else { 'main' }

  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Host 'Melete: Docker is needed. Install Docker Desktop (https://docs.docker.com/desktop/), start it, then run this again.'
    $global:LASTEXITCODE = 1
    return
  }

  $bash = $null
  $git = Get-Command git -ErrorAction SilentlyContinue
  if ($git) {
    # git.exe lives in <Git>\cmd or <Git>\bin; bash.exe is in <Git>\bin.
    $root = Split-Path (Split-Path $git.Source -Parent) -Parent
    $candidate = Join-Path $root 'bin\bash.exe'
    if (Test-Path -LiteralPath $candidate) { $bash = $candidate }
  }
  if (-not $bash) {
    foreach ($candidate in @("$env:ProgramFiles\Git\bin\bash.exe", "$env:LocalAppData\Programs\Git\bin\bash.exe")) {
      if (Test-Path -LiteralPath $candidate) { $bash = $candidate; break }
    }
  }
  if (-not $bash) {
    Write-Host 'Melete: Git for Windows is needed to run the installer. Install it from https://git-scm.com/download/win, then run this again.'
    $global:LASTEXITCODE = 1
    return
  }

  $script = Join-Path ([System.IO.Path]::GetTempPath()) ("melete-install-{0}.sh" -f [guid]::NewGuid())
  try {
    Invoke-WebRequest -UseBasicParsing -Uri "https://raw.githubusercontent.com/ychampion/melete/$ref/install.sh" -OutFile $script
    & $bash $script
  } finally {
    Remove-Item -LiteralPath $script -Force -ErrorAction SilentlyContinue
  }
}
