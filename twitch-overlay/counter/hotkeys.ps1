# Odinheim — ToA dry counter hotkeys (Windows, no installs)
#
#   Easiest: double-click  run-hotkeys.bat   (it keeps this window open and
#            bypasses PowerShell's script-execution policy)
#   Or:      powershell -NoProfile -ExecutionPolicy Bypass -File hotkeys.ps1
#
# Numpad +      a chest opened   (+1)
# Numpad -      undo one          (-1)
# Numpad 0      GOT A PURPLE      (banks the streak, back to 0)
# Numpad .      same as above
#
# Add -Test to print every key's virtual-key code as you press it — that tells
# you whether Windows sees the key at all, and which number to bind.
#
# Change the keys below if you like. Numbers are Windows virtual key codes:
#   0x60..0x69 = Numpad 0..9     0x6B = Numpad +     0x6D = Numpad -
#   0x6E = Numpad .              0x70..0x7B = F1..F12
#   0x21 = PageUp  0x22 = PageDown  0x24 = Home  0x23 = End  0x2D = Insert
#   0xBB = the "+" next to backspace   0xBD = the "-" next to it
#
# Why this exists: OBS browser sources only receive keystrokes when their
# Interact window is focused. This listens system-wide, so it works while you're
# in-game with OBS in the background.
#
# Keep this window open while you stream (minimise it). Ctrl+C or closing the
# window stops it.

param([switch]$Test)

$ErrorActionPreference = "Stop"
$BaseUrl = "http://127.0.0.1:7391"

function Say($text, $colour = "Gray") { Write-Host $text -ForegroundColor $colour }

# --- key code -> API path ---------------------------------------------------
$Bindings = [ordered]@{
    0x6B = "/api/bump?d=1"     # Numpad +   chest opened
    0x6D = "/api/bump?d=-1"    # Numpad -   undo
    0x60 = "/api/purple"       # Numpad 0   PURPLE
    0x6E = "/api/purple"       # Numpad .   PURPLE
}

$Names = @{
    0x6B = "Numpad +"; 0x6D = "Numpad -"; 0x60 = "Numpad 0"; 0x6E = "Numpad ."
    0xBB = "the + key"; 0xBD = "the - key"
    0x70 = "F1"; 0x71 = "F2"; 0x72 = "F3"; 0x73 = "F4"; 0x74 = "F5"; 0x75 = "F6"
    0x76 = "F7"; 0x77 = "F8"; 0x78 = "F9"; 0x79 = "F10"; 0x7A = "F11"; 0x7B = "F12"
    0x0D = "Enter"; 0x20 = "Space"; 0x2D = "Insert"; 0x2E = "Delete"
}

Say ""
Say "  Odinheim - ToA dry counter hotkeys" "Yellow"
Say "  ---------------------------------"
foreach ($vk in $Bindings.Keys) {
    $label = if ($Names.ContainsKey($vk)) { $Names[$vk] } else { "key 0x{0:X}" -f $vk }
    Say ("  {0,-12} -> {1}" -f $label, $Bindings[$vk])
}
Say ""

# --- can we even talk to the counter? ---------------------------------------
try {
    $state = Invoke-RestMethod -Uri "$BaseUrl/api/state" -TimeoutSec 3
    Say ("  connected to the counter - dry {0}, best {1}, {2} purples" -f $state.count, $state.best, $state.purples) "Green"
} catch {
    Say "  !! The counter server is NOT running." "Red"
    Say "     Start it first, in another window:" "Red"
    Say "       node counter-server.js" "Red"
    Say "     (this listener will keep trying anyway)" "DarkGray"
}

# --- load the key-state call ------------------------------------------------
try {
    Add-Type -Namespace Win -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
'@
} catch {
    Say ""
    Say "  !! Could not load the Windows key API (Add-Type failed)." "Red"
    Say ("     " + $_.Exception.Message) "DarkRed"
    Say "     Try running this in PowerShell 7 instead (pwsh.exe), or tell me the" "Red"
    Say "     message above and I'll switch you to a different method." "Red"
    Say ""
    Read-Host "  Press Enter to close"
    exit 1
}

if ($Test) {
    Say "  TEST MODE - press keys. Every key will print its code." "Cyan"
    Say "  Press Ctrl+C when you've seen what you need." "DarkGray"
    Say ""
}

Say "  Ready. Leave this window open while you stream. Ctrl+C to stop." "Green"
Say ""

$held = @{}
foreach ($vk in $Bindings.Keys) { $held[$vk] = $false }

# in test mode, watch everything so we can report unexpected key codes
$watch = if ($Test) { 1..254 } else { @($Bindings.Keys) }

$offline = $false

try {
    while ($true) {
        foreach ($vk in $watch) {
            $isDown = ([Win.Native]::GetAsyncKeyState($vk) -band 0x8000) -ne 0
            if (-not $isDown) { $held[$vk] = $false; continue }

            if ($held[$vk]) { continue }
            $held[$vk] = $true

            if ($Test) {
                Say ("  key down: VK {0} (0x{0:X})" -f $vk) "Cyan"
            }

            if (-not $Bindings.Contains($vk)) { continue }

            $path = $Bindings[$vk]
            $label = if ($Names.ContainsKey($vk)) { $Names[$vk] } else { "key 0x{0:X}" -f $vk }
            try {
                $result = Invoke-RestMethod -Uri "$BaseUrl$path" -TimeoutSec 3 -ErrorAction Stop
                $offline = $false
                Say ("  {0,-11} {1:HH:mm:ss}  {2}  -> dry {3}" -f $label, (Get-Date), $path, $result.count) "Green"
                if ($path -eq "/api/purple") {
                    Say ("               purple banked at {0} dry (best {1})" -f $result.streak, $result.best) "Magenta"
                }
            } catch {
                if (-not $offline) {
                    Say "  !! counter server not answering - is counter-server.js running?" "Red"
                    $offline = $true
                }
            }
        }
        Start-Sleep -Milliseconds 35
    }
}
finally {
    Say ""
    Say "  Hotkeys stopped." "DarkGray"
}
