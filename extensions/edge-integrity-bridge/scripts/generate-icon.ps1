Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 128, 128
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush (
    [System.Drawing.Rectangle]::new(0, 0, 128, 128),
    [System.Drawing.Color]::FromArgb(255, 145, 70, 255),
    [System.Drawing.Color]::FromArgb(255, 119, 44, 232),
    45
)
$g.FillEllipse($brush, 4, 4, 120, 120)
$g.FillEllipse([System.Drawing.Brushes]::White, 36, 44, 56, 40)
$g.FillEllipse($brush, 52, 54, 24, 24)
$outPath = Join-Path (Join-Path $PSScriptRoot '..') 'icon128.png'
$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
