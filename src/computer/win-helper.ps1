param(
  [Parameter(Mandatory = $true)][string]$Payload
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Payload)) | ConvertFrom-Json

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public static class GatitaInput {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, int dwData, IntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, IntPtr dwExtraInfo);

    public const uint LEFTDOWN = 0x0002;
    public const uint LEFTUP = 0x0004;
    public const uint RIGHTDOWN = 0x0008;
    public const uint RIGHTUP = 0x0010;
    public const uint MIDDLEDOWN = 0x0020;
    public const uint MIDDLEUP = 0x0040;
    public const uint WHEEL = 0x0800;
    public const uint KEYUP = 0x0002;
    public const uint UNICODE = 0x0004;

    public static void Move(int x, int y) { SetCursorPos(x, y); }

    public static void Click(string button, bool doubleClick) {
        uint down = LEFTDOWN, up = LEFTUP;
        if (button == "right") { down = RIGHTDOWN; up = RIGHTUP; }
        else if (button == "middle") { down = MIDDLEDOWN; up = MIDDLEUP; }
        int times = doubleClick ? 2 : 1;
        for (int i = 0; i < times; i++) {
            mouse_event(down, 0, 0, 0, IntPtr.Zero);
            System.Threading.Thread.Sleep(40);
            mouse_event(up, 0, 0, 0, IntPtr.Zero);
            if (doubleClick) System.Threading.Thread.Sleep(60);
        }
    }

    public static void Drag(int fromX, int fromY, int toX, int toY) {
        SetCursorPos(fromX, fromY);
        System.Threading.Thread.Sleep(80);
        mouse_event(LEFTDOWN, 0, 0, 0, IntPtr.Zero);
        System.Threading.Thread.Sleep(80);
        int steps = 20;
        for (int i = 1; i <= steps; i++) {
            int x = fromX + (toX - fromX) * i / steps;
            int y = fromY + (toY - fromY) * i / steps;
            SetCursorPos(x, y);
            System.Threading.Thread.Sleep(15);
        }
        System.Threading.Thread.Sleep(80);
        mouse_event(LEFTUP, 0, 0, 0, IntPtr.Zero);
    }

    public static void Scroll(int clicks) {
        mouse_event(WHEEL, 0, 0, clicks * 120, IntPtr.Zero);
    }

    public static void TypeText(string text) {
        foreach (char ch in text) {
            keybd_event(0, (byte)ch, UNICODE, IntPtr.Zero);
            keybd_event(0, (byte)ch, UNICODE | KEYUP, IntPtr.Zero);
            System.Threading.Thread.Sleep(8);
        }
    }

    public static void KeyCombo(string combo) {
        string[] parts = combo.ToUpperInvariant().Split('+');
        var modifiers = new System.Collections.Generic.List<Keys>();
        for (int i = 0; i < parts.Length - 1; i++) {
            string part = parts[i].Trim();
            if (part == "CTRL" || part == "CONTROL") modifiers.Add(Keys.ControlKey);
            else if (part == "SHIFT") modifiers.Add(Keys.ShiftKey);
            else if (part == "ALT") modifiers.Add(Keys.Menu);
            else if (part == "WIN" || part == "SUPER") modifiers.Add(Keys.LWin);
        }
        string keyName = parts[parts.Length - 1].Trim();
        if (keyName == "ENTER" || keyName == "RETURN") keyName = "Enter";
        if (keyName == "ESC") keyName = "Escape";
        if (keyName == "DEL") keyName = "Delete";
        if (keyName == "INS") keyName = "Insert";
        if (keyName == "SPACE") keyName = "Space";
        if (keyName == "TAB") keyName = "Tab";
        if (keyName == "UP") keyName = "Up";
        if (keyName == "DOWN") keyName = "Down";
        if (keyName == "LEFT") keyName = "Left";
        if (keyName == "RIGHT") keyName = "Right";
        Keys key;
        if (!Enum.TryParse(keyName, true, out key)) {
            throw new ArgumentException("Unknown key: " + keyName);
        }
        foreach (var mod in modifiers) {
            keybd_event((byte)mod, 0, 0, IntPtr.Zero);
            System.Threading.Thread.Sleep(20);
        }
        keybd_event((byte)key, 0, 0, IntPtr.Zero);
        System.Threading.Thread.Sleep(40);
        keybd_event((byte)key, 0, KEYUP, IntPtr.Zero);
        for (int i = modifiers.Count - 1; i >= 0; i--) {
            keybd_event((byte)modifiers[i], 0, KEYUP, IntPtr.Zero);
            System.Threading.Thread.Sleep(20);
        }
    }
}
"@ -ReferencedAssemblies System.Windows.Forms, System.Drawing

[void][GatitaInput]::SetProcessDPIAware()
$action = [string]$json.action

function Out-Json($obj) {
  $obj | ConvertTo-Json -Compress -Depth 6
}

try {
  switch ($action) {
    'screenshot' {
      $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
      if ($json.fullScreen) {
        $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
      }
      $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
      $graphics.Dispose()
      $maxWidth = 1440
      if ($bitmap.Width -gt $maxWidth) {
        $ratio = $maxWidth / $bitmap.Width
        $newWidth = [int]$maxWidth
        $newHeight = [int]($bitmap.Height * $ratio)
        $scaled = New-Object System.Drawing.Bitmap $newWidth, $newHeight
        $scaledGraphics = [System.Drawing.Graphics]::FromImage($scaled)
        $scaledGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $scaledGraphics.DrawImage($bitmap, 0, 0, $newWidth, $newHeight)
        $scaledGraphics.Dispose()
        $bitmap.Dispose()
        $bitmap = $scaled
      }
      $directory = Split-Path -Parent $json.outputPath
      if (!(Test-Path $directory)) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
      $bitmap.Save($json.outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
      $result = @{
        ok = $true
        path = $json.outputPath
        width = $bitmap.Width
        height = $bitmap.Height
        screenWidth = $bounds.Width
        screenHeight = $bounds.Height
      }
      $bitmap.Dispose()
      Out-Json $result
    }
    'move' {
      [void][GatitaInput]::Move([int]$json.x, [int]$json.y)
      Out-Json @{ ok = $true; x = [int]$json.x; y = [int]$json.y }
    }
    'click' {
      if ($null -ne $json.x -and $null -ne $json.y) {
        [void][GatitaInput]::Move([int]$json.x, [int]$json.y)
        Start-Sleep -Milliseconds 80
      }
      $button = 'left'
      if ($json.button) { $button = [string]$json.button }
      [GatitaInput]::Click($button, [bool]$json.doubleClick)
      $position = [System.Windows.Forms.Cursor]::Position
      Out-Json @{ ok = $true; button = $button; x = $position.X; y = $position.Y }
    }
    'scroll' {
      if ($null -ne $json.x -and $null -ne $json.y) {
        [void][GatitaInput]::Move([int]$json.x, [int]$json.y)
      }
      [GatitaInput]::Scroll([int]$json.clicks)
      Out-Json @{ ok = $true; clicks = [int]$json.clicks }
    }
    'type' {
      [GatitaInput]::TypeText([string]$json.text)
      Out-Json @{ ok = $true; characters = ([string]$json.text).Length }
    }
    'key' {
      [GatitaInput]::KeyCombo([string]$json.keys)
      Out-Json @{ ok = $true; keys = [string]$json.keys }
    }
    'drag' {
      [GatitaInput]::Drag([int]$json.fromX, [int]$json.fromY, [int]$json.toX, [int]$json.toY)
      Out-Json @{ ok = $true; fromX = [int]$json.fromX; fromY = [int]$json.fromY; toX = [int]$json.toX; toY = [int]$json.toY }
    }
    'cursor' {
      $position = [System.Windows.Forms.Cursor]::Position
      $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
      Out-Json @{ ok = $true; x = $position.X; y = $position.Y; screenWidth = $bounds.Width; screenHeight = $bounds.Height }
    }
    default {
      throw "Unknown action: $action"
    }
  }
} catch {
  Out-Json @{ ok = $false; error = $_.Exception.Message }
  exit 1
}
