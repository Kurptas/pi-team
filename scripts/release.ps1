# release.ps1 — create a GitHub Release for the current pi-team version.
#
# WHY a PowerShell script (not bundled into sync-release.mjs):
#   The GitHub token lives in your PowerShell session ($env:GH_TOKEN). A bash /
#   node child process spawned elsewhere does NOT inherit it, so the Release step
#   must run in the same shell that holds the token. This script is that shell.
#
# WHAT it does:
#   1. Reads the version from the release repo's package.json.
#   2. Generates a release note from a template (highlights are editable below).
#   3. Creates the GitHub Release for tag vX.Y.Z via gh.exe.
#
# PREREQUISITES (must already be done — this script does NOT do them):
#   - The tag vX.Y.Z is already pushed to origin (git tag + git push origin tag).
#   - gh is authenticated: $env:GH_TOKEN is set, OR `gh auth login` completed.
#
# USAGE (from the pi-team dev repo root, in PowerShell):
#   $env:GH_TOKEN = "<your token>"          # if not already set
#   .\scripts\release.ps1                    # uses release repo version + tag
#   .\scripts\release.ps1 -DryRun            # print what would happen, create nothing
#
# The token is never written to disk or echoed. Keep it in your session only.

param(
    [string]$ReleaseRepo = "D:\Develops\pi-team-release",
    [string]$Repo        = "Kurptas/pi-team",
    [string]$GhPath      = "C:\Program Files\GitHub CLI\gh.exe",
    [switch]$DryRun,
    [switch]$SkipRepoMeta   # skip the description + topics sync (step 4)
)

# Repo description + topics, kept in the script so they stay version-controlled
# and consistent with the README value proposition. gh applies them idempotently
# (re-running just re-sets the same values), so it is safe on every release.
$RepoDescription = "A Pi extension for multi-LLM orchestration. Instead of trusting one model, put your task to a team of different LLMs - a review panel, a research roundtable, a bull-vs-bear debate - that cover each other's blind spots. The strongest model judges while lean models do the legwork."
$RepoTopics = @("agentic-ai", "multi-agent", "multi-llm", "agent-orchestration", "llm-orchestration", "ai-agents", "ai-debate", "collective-intelligence", "ai-productivity", "pi", "pi-extension")

$ErrorActionPreference = "Stop"

# --- 1. Read version from the release repo's package.json -------------------
$pkgPath = Join-Path $ReleaseRepo "package.json"
if (-not (Test-Path $pkgPath)) {
    Write-Error "package.json not found at $pkgPath — is the release repo synced?"
    exit 1
}
$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
$version = $pkg.version
$tag = "v$version"
Write-Host "Version: $version   Tag: $tag   Repo: $Repo"

# --- 2. Verify gh is present + authenticated --------------------------------
if (-not (Test-Path $GhPath)) {
    Write-Error "gh.exe not found at $GhPath — install GitHub CLI or pass -GhPath."
    exit 1
}
& $GhPath auth status 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Error "gh is not authenticated. Set `$env:GH_TOKEN or run '$GhPath auth login', then retry."
    exit 1
}

# --- 3. Build the release note ----------------------------------------------
# Edit the highlights for each release. Everything else is boilerplate.
$title = "$tag"
$note = @"
pi-team lets Pi assemble a small squad of AI agents and put them to work on a single task — different models covering each other's blind spots, each one doing what it does best.

## Highlights
- Run any task across several models at once: code review, research, financial analysis, debugging, decisions
- The right model on each job — strong models judge, lean ones scan
- Stay in the loop: watch each member live, steer or stop mid-run
- Ready-made team templates, or let Pi design one on the spot
- Per-role tool whitelists keep each worker confined to what it needs

## Install
``````bash
pi install npm:pi-team
``````
Or pin from git: ``pi install git:github.com/$Repo@$tag``

Then run ``/reload`` in Pi.
"@

# Write the note to a temp file OUTSIDE both repos (never committed/published).
$noteFile = Join-Path $env:TEMP "pi-team-release-note-$tag.md"
$note | Set-Content -Path $noteFile -Encoding UTF8
Write-Host "Release note written to: $noteFile"

if ($DryRun) {
    Write-Host "`n--- DRY RUN — would apply the following, create nothing ---"
    if (-not $SkipRepoMeta) {
        Write-Host "Repo description: $RepoDescription"
        Write-Host "Repo topics:      $($RepoTopics -join ', ')"
    }
    Write-Host "Tag:   $tag"
    Write-Host "Title: $title"
    Write-Host "`n$note`n"
    Write-Host "--- nothing created ---"
    exit 0
}

# --- 4. Sync repo description + topics (idempotent) --------------------------
if (-not $SkipRepoMeta) {
    $topicArgs = @()
    foreach ($t in $RepoTopics) { $topicArgs += "--add-topic"; $topicArgs += $t }
    & $GhPath repo edit $Repo --description $RepoDescription @topicArgs
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "gh repo edit failed (exit $LASTEXITCODE) — continuing to the release step anyway."
    } else {
        Write-Host "Repo description + topics synced."
    }
}

# --- 5. Create the GitHub Release --------------------------------------------
& $GhPath release create $tag --repo $Repo --title $title --notes-file $noteFile
if ($LASTEXITCODE -ne 0) {
    Write-Error "gh release create failed (exit $LASTEXITCODE). If the release already exists, edit it on GitHub or delete it first."
    exit 1
}

Write-Host "`nRelease $tag created: https://github.com/$Repo/releases/tag/$tag"
