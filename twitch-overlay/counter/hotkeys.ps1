# Odinheim counter — global hotkeys for Windows. No installs, no plugins.
#
#   Right-click this file -> "Run with PowerShell"
#
# Numpad +      a chest opened   (+1)
# Numpad -      undo one          (-1)
# Numpad 0      GOT A PURPLE      (banks the streak, back to 0)
#
# Change the keys below if you like. The numbers are Windows "virtual key codes":
#   0x60..0x69 = Numpad 0..9      0x6B = Numpad +      0x6D = Numpad -
#   0x70..0x7B = F1..F12          0x21 = Page Up       0x22 = Page Down
#   0x24 = Home  0x23 = End       0x2D = Insert        0x2E = Delete
#
# Why this exists: OBS browser sources only receive keystrokes when their
# Interact window is focused. This listens system-wide, so it works while you're
# in-game with OBS in the background.
#
# Keep this window open while you stream (minimise it). Ctrl+C or closing the
# window stops it.

$ErrorActionPreference = "Stop"
$BaseUrl = "http://127.0.0.1:7391"

# --- key code -> API path ---------------------------------------------------
$Bindings = [ordered]@{
    0x6B = "/api/bump?d=1"     # Numpad +   chest opened
    0x6D = "/api/bump?d=-1"    # Numpad -   undo
    0x60 = "/api/purple"       # Numpad 0   GOT A PURPLE
    0x6E = "/api/purple"       # Numpad .   same thing, easier to hit
}

$Names = @{
    0x6B = "Numpad +"; 0x6D = "Numpad -"; 0x60 = "Numpad 0"; 0x6E = "Numpad ."
    0x70 = "F1"; 0x71 = "F2"; 0x72 = "F3"; 0x73 = "F4"; 0x74 = "F5"; 0x75 = "F6"
    0x76 = "F7"; 0x77 = "F8"; 0x78 = "F9"; 0x79 = "F10"; 0x7A = "F11"; 0x7B = "F12"
}

Add-Type -Namespace Win -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
'@

Write-Host ""
Write-Host "  ToA dry counter - hotkeys" -ForegroundColor Yellow
Write-Host "  ------------------------"
foreach ($vk in $Bindings.Keys) {
    $label = if ($Names.ContainsKey($vk)) { $Names[$vk] } else { "key 0x{0:X}" -f $vk }
    Write-Host ("  {0,-10} -> {1}" -f $label, $Bindings[$vk])
}
Write-Host ""
Write-Host "  Sending to $BaseUrl" -ForegroundColor DarkGray
Write-Host "  Leave this window open while streaming. Ctrl+C to stop." -ForegroundColor DarkGray
Write-Host ""

$held = @{}
foreach ($vk in $Bindings.Keys) { $held[$vk] = $false }

try {
    while ($true) {
        foreach ($vk in @($Bindings.Keys)) {
            # high bit set == key currently down
            $isDown = ([Win.Native]::GetAsyncKeyState($vk) -band 0x8000) -ne 0

            if ($isDown -and -not $held[$vk]) {
                $held[$vk] = $true
                $path = $Bindings[$vk]
                try {
                    Invoke-RestMethod -Uri "$BaseUrl$path" -TimeoutSec 2 -ErrorAction Stop | Out-Null
                    $label = if ($Names.ContainsKey($vk)) { $Names[$vk] } else { "key" }
                    Write-Host ("  {0}  {1:HH:mm:ss}  {2}" -f $label, (Get-Date), $path) -ForegroundColor Green
                } catch {
                    Write-Host "  counter server not running - start it with: node counter-server.js" -ForegroundColor Red
                }
            }
            elseif (-not $isDown) {
                $held[$vk] = $false
            }
        }
        Start-Sleep -Milliseconds 35
    }
}
finally {
    Write-Host ""
    Write-Host "  Hotkeys stopped." -ForegroundColor DarkGray
}
