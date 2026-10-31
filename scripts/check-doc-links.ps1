# Local Markdown file destinations only; URL availability and heading anchors are not checked.
# Run: pwsh -NoProfile -File scripts/check-doc-links.ps1
[CmdletBinding()]
param(
    [string]$Root = (Join-Path $PSScriptRoot '../docs')
)

$ErrorActionPreference = 'Stop'
$rootPath = (Resolve-Path -LiteralPath $Root).Path
$files = @(Get-ChildItem -LiteralPath $rootPath -Recurse -File -Filter '*.md')
$checked = 0
$missing = [Collections.Generic.List[string]]::new()

foreach ($file in $files) {
    # This raw transcript quotes links from another agent's old memory directory.
    # Preserve that evidence; do not treat the quoted paths as maintained docs.
    $relative = $file.FullName.Substring($rootPath.Length).TrimStart([char[]]'\/').Replace('\', '/')
    if ($relative -eq 'discover/specs/2026-06-21-devflow-skill-rebuild-RAW-transcript.md') {
        Write-Output ('Historical transcript excluded: {0}' -f $file.FullName)
        continue
    }
    $text = [IO.File]::ReadAllText($file.FullName)
    # Preserve newlines for diagnostics. Examples inside fenced/inline code and HTML
    # comments are not links in the rendered document.
    $blank = { param($m) [regex]::Replace($m.Value, '[^\r\n]', ' ') }
    $text = [regex]::Replace($text, '(?ms)^ {0,3}(`{3,}|~{3,})[^\r\n]*\r?\n.*?^ {0,3}\1[ \t]*(?=\r?$)', $blank)
    $text = [regex]::Replace($text, '(?s)<!--.*?-->', $blank)
    $text = [regex]::Replace($text, '(?s)(`+)(?!`).*?(?<!`)\1(?!`)', $blank)
    # Inline links/images and reference definitions. Balanced parentheses in bare
    # destinations are supported (one nested pair); use <...> for more complex paths.
    $pattern = '(?m)(?:!?\[[^\]\r\n]*\]\(\s*|^ {0,3}\[[^\]\r\n]+\]:[ \t]*)(?:<(?<dest>[^>\r\n]+)>|(?<dest>(?:[^\s()\\]|\\.|\([^()]*\))+))'
    foreach ($match in [regex]::Matches($text, $pattern)) {
        $dest = $match.Groups['dest'].Value
        if ($dest -match '^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|//|#|/)') { continue }
        $dest = ($dest -split '[?#]', 2)[0]
        if (-not $dest) { continue }
        $dest = [Uri]::UnescapeDataString($dest)
        $dest = [regex]::Replace($dest, '\\([!"#$%&''()*+,\-./:;<=>?@\[\]\\^_`{|}~])', '$1')
        $target = Join-Path $file.DirectoryName $dest
        $checked++
        if (-not (Test-Path -LiteralPath $target)) {
            $line = 1 + ([regex]::Matches($text.Substring(0, $match.Index), '\n')).Count
            $missing.Add(('{0}:{1}: {2}' -f $file.FullName, $line, $dest))
        }
    }
}

foreach ($item in $missing) { Write-Output $item }
Write-Output ('Markdown files: {0}; local destinations: {1}; missing: {2}' -f $files.Count, $checked, $missing.Count)
if ($missing.Count -gt 0) { exit 1 }
exit 0
