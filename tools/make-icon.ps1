# Builds the app artwork from the one source file, logo.png, so the logo only ever has to be
# replaced in one place.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/make-icon.ps1
#
# Writes
#   native\assets\steamar.ico   16,24,32,48,64 as BMP and 128,256 as PNG - what Windows needs for
#                               the taskbar, alt-tab, Explorer and the shortcut, each at its own size
#   ui\logo.png                 128px copy for the rail mark and the browser tab
#
# A single-size .ico looks soft everywhere Windows asks for a size it does not carry, which is why
# this writes the whole ladder instead of reusing whatever was handed over.

Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$source = Join-Path $root 'logo.png'
if (-not (Test-Path $source)) { throw "missing $source" }

$icon_out = Join-Path $root 'native\assets\steamar.ico'
$ui_out = Join-Path $root 'ui\logo.png'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $icon_out) | Out-Null

$image = [System.Drawing.Image]::FromFile($source)
$sizes = 16, 24, 32, 48, 64, 128, 256
$entries = @()

foreach ($size in $sizes) {
  $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $canvas = [System.Drawing.Graphics]::FromImage($bitmap)
  $canvas.InterpolationMode = 'HighQualityBicubic'
  $canvas.PixelOffsetMode = 'HighQuality'
  $canvas.CompositingQuality = 'HighQuality'
  $canvas.Clear([System.Drawing.Color]::Transparent)
  $canvas.DrawImage($image, 0, 0, $size, $size)
  $canvas.Dispose()

  if ($size -ge 128) {
    # PNG payload: small and exact, and Vista and newer read it everywhere an icon is shown.
    $stream = [System.IO.MemoryStream]::new()
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $entries += , @($size, $stream.ToArray())
    $stream.Dispose()
  } else {
    # DIB payload, bottom-up BGRA plus the legacy AND mask, for the shells that still expect it.
    $rect = [System.Drawing.Rectangle]::new(0, 0, $size, $size)
    $locked = $bitmap.LockBits($rect, 'ReadOnly', 'Format32bppArgb')
    $pixels = [byte[]]::new($locked.Stride * $size)
    [System.Runtime.InteropServices.Marshal]::Copy($locked.Scan0, $pixels, 0, $pixels.Length)
    $bitmap.UnlockBits($locked)

    $mask_stride = [int]([math]::Ceiling($size / 32) * 4)
    $stream = [System.IO.MemoryStream]::new()
    $writer = [System.IO.BinaryWriter]::new($stream)
    $writer.Write([int]40)                                   # biSize
    $writer.Write([int]$size)                                # biWidth
    $writer.Write([int]($size * 2))                          # biHeight: image + mask
    $writer.Write([int16]1)                                  # biPlanes
    $writer.Write([int16]32)                                 # biBitCount
    $writer.Write([int]0)                                    # biCompression: BI_RGB
    $writer.Write([int]($size * $size * 4 + $mask_stride * $size))
    foreach ($skip in 1..4) { $writer.Write([int]0) }        # resolution and palette fields
    for ($y = $size - 1; $y -ge 0; $y--) { $writer.Write($pixels, $y * $locked.Stride, $size * 4) }
    $writer.Write([byte[]]::new($mask_stride * $size))       # AND mask: alpha already carries it
    $writer.Flush()
    $entries += , @($size, $stream.ToArray())
    $writer.Dispose()
    $stream.Dispose()
  }

  $bitmap.Dispose()
}

$file = [System.IO.File]::Create($icon_out)
$icon = [System.IO.BinaryWriter]::new($file)
$icon.Write([int16]0)          # reserved
$icon.Write([int16]1)          # type: icon
$icon.Write([int16]$entries.Count)
$offset = 6 + 16 * $entries.Count
foreach ($entry in $entries) {
  $size = $entry[0]
  $payload = $entry[1]
  $dimension = if ($size -ge 256) { 0 } else { $size }
  $icon.Write([byte]$dimension)
  $icon.Write([byte]$dimension)
  $icon.Write([byte]0)         # palette colours
  $icon.Write([byte]0)         # reserved
  $icon.Write([int16]1)        # planes
  $icon.Write([int16]32)       # bits per pixel
  $icon.Write([int]$payload.Length)
  $icon.Write([int]$offset)
  $offset += $payload.Length
}
foreach ($entry in $entries) { $icon.Write([byte[]]$entry[1]) }
$icon.Flush()
$icon.Dispose()
$image.Dispose()

# The rail mark never renders above 26 CSS pixels, so 128 covers it on any display without
# shipping the 512px original to every window.
$big = [System.Drawing.Image]::FromFile($source)
$small = [System.Drawing.Bitmap]::new(128, 128, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$paint = [System.Drawing.Graphics]::FromImage($small)
$paint.InterpolationMode = 'HighQualityBicubic'
$paint.PixelOffsetMode = 'HighQuality'
$paint.CompositingQuality = 'HighQuality'
$paint.Clear([System.Drawing.Color]::Transparent)
$paint.DrawImage($big, 0, 0, 128, 128)
$paint.Dispose()
$small.Save($ui_out, [System.Drawing.Imaging.ImageFormat]::Png)
$small.Dispose()
$big.Dispose()

$ico_bytes = (Get-Item $icon_out).Length
$png_bytes = (Get-Item $ui_out).Length
Write-Host "native\assets\steamar.ico  $ico_bytes bytes  ($($sizes -join ', '))"
Write-Host "ui\logo.png                $png_bytes bytes  (128px)"
