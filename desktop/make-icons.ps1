$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$root = Join-Path $PSScriptRoot "assets"
$source = [System.Drawing.Image]::FromFile((Join-Path (Split-Path $PSScriptRoot -Parent) "icon-256.png"))
New-Item -ItemType Directory -Force -Path $root | Out-Null

function New-LaneBitmap([int]$size) {
  $bitmap = New-Object System.Drawing.Bitmap($size, $size)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
  $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([System.Drawing.Color]::Transparent)
  $graphics.DrawImage($source, 0, 0, $size, $size)
  $graphics.Dispose()
  return $bitmap
}

foreach ($size in @(16, 24, 32, 48, 64, 128, 256)) {
  $bitmap = New-LaneBitmap $size
  $bitmap.Save((Join-Path $root "lane-$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()
}

$tray = New-LaneBitmap 64
$tray.Save((Join-Path $root "tray.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$tray.Dispose()
$source.Dispose()

Add-Type -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Collections.Generic;

public static class LaneIco {
  public static void Write(string output, params string[] files) {
    var images = new List<byte[]>();
    foreach (var file in files) {
      using (var source = new Bitmap(file))
      using (var buffer = new MemoryStream()) {
        source.Save(buffer, ImageFormat.Png);
        images.Add(buffer.ToArray());
      }
    }
    using (var stream = new FileStream(output, FileMode.Create))
    using (var writer = new BinaryWriter(stream)) {
      writer.Write((short)0);
      writer.Write((short)1);
      writer.Write((short)images.Count);
      var offset = 6 + 16 * images.Count;
      foreach (var bytes in images) {
        var size = bytes.Length;
        using (var image = new Bitmap(new MemoryStream(bytes))) {
          writer.Write((byte)(image.Width >= 256 ? 0 : image.Width));
          writer.Write((byte)(image.Height >= 256 ? 0 : image.Height));
        }
        writer.Write((byte)0);
        writer.Write((byte)0);
        writer.Write((short)1);
        writer.Write((short)32);
        writer.Write(size);
        writer.Write(offset);
        offset += size;
      }
      foreach (var bytes in images) writer.Write(bytes);
    }
  }
}
"@ -ReferencedAssemblies System.Drawing

[LaneIco]::Write(
  (Join-Path $root "lane.ico"),
  (Join-Path $root "lane-16.png"),
  (Join-Path $root "lane-24.png"),
  (Join-Path $root "lane-32.png"),
  (Join-Path $root "lane-48.png"),
  (Join-Path $root "lane-64.png"),
  (Join-Path $root "lane-128.png"),
  (Join-Path $root "lane-256.png")
)
[LaneIco]::Write(
  (Join-Path $root "tray.ico"),
  (Join-Path $root "lane-16.png"),
  (Join-Path $root "lane-24.png"),
  (Join-Path $root "lane-32.png")
)

Write-Output "Generated Lane icons in $root"
