# scripts/

Setup and maintenance scripts. Application code does not live here.

| Script | Runs on | Purpose |
|---|---|---|
| `setup-dev-env.ps1` | Windows, **elevated** PowerShell | Installs the entire toolchain. Skips anything already present, so it is safe to re-run and doubles as a repair tool |
| `setup-wsl.sh` | Inside WSL / Ubuntu | Provisions the Linux side — apt tooling, `swaks`, `dig`, `psql`, Node 22, pnpm, .NET 10 |

## Usage

```powershell
.\scripts\setup-dev-env.ps1 -DryRun     # show what it would do
.\scripts\setup-dev-env.ps1             # install what is missing
.\scripts\setup-dev-env.ps1 -Upgrade    # refresh everything already installed
.\scripts\setup-dev-env.ps1 -Skip Mobile
```

`setup-dev-env.ps1` embeds its own copy of the WSL bootstrap, so it works standalone. `setup-wsl.sh` is kept here separately for reading and for running by hand.

A reboot is required the first time WSL2 installs. Re-run afterwards — it picks up where it stopped.

## Detection

Before installing anything, each package is checked three ways: the winget registry, the executable on `PATH`, and known install locations. Something you installed manually will be recognised and left alone.
