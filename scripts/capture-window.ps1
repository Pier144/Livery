param([string]$Out = "$PSScriptRoot\livery.png")
# Captures the visible Livery window with PrintWindow (no focus change). If minimized, restores it
# without activation and minimizes it again afterwards.
Add-Type -AssemblyName System.Drawing
if (-not ('LvCap' -as [type])) {
Add-Type @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class LvCap {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint f);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  public static IntPtr Find(uint pid) { IntPtr found = IntPtr.Zero; EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); var sb = new StringBuilder(64); GetWindowText(h, sb, 64); if (p == pid && sb.ToString() == "Livery") { found = h; return false; } return true; }, IntPtr.Zero); return found; }
}
'@
}
$p = Get-Process livery -ErrorAction Stop | Select-Object -First 1
$h = [LvCap]::Find([uint32]$p.Id)
if ($h -eq [IntPtr]::Zero) { throw 'Livery window not found' }
$wasIconic = [LvCap]::IsIconic($h)
if ($wasIconic) { [void][LvCap]::ShowWindow($h, 4); Start-Sleep -Milliseconds 800 }
$r = New-Object LvCap+RECT; [void][LvCap]::GetWindowRect($h, [ref]$r)
$w = $r.R - $r.L; $ht = $r.B - $r.T
$bmp = New-Object System.Drawing.Bitmap $w, $ht; $g = [System.Drawing.Graphics]::FromImage($bmp); $hdc = $g.GetHdc()
[void][LvCap]::PrintWindow($h, $hdc, 2); $g.ReleaseHdc($hdc); $g.Dispose()
# Crop the invisible resize borders (8px left/right/bottom on Windows 11).
$crop = $bmp.Clone((New-Object System.Drawing.Rectangle 8, 0, ($w - 16), ($ht - 8)), $bmp.PixelFormat)
$crop.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png); $crop.Dispose(); $bmp.Dispose()
if ($wasIconic) { [void][LvCap]::ShowWindow($h, 7) }
"$Out ${w}x${ht} iconic=$wasIconic"
