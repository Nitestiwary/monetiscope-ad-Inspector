$source = "C:\Users\Nitesh Kumar\.gemini\antigravity\brain\0117b47d-8940-4d4a-affa-b6677de8337e\media__1779893562567.jpg"
$destDir = "C:\Users\Nitesh Kumar\.gemini\antigravity\scratch\monetiscope-ad-inspector\assets"

if (-not (Test-Path $source)) {
    Write-Error "Source image not found at $source"
    exit 1
}

if (-not (Test-Path $destDir)) {
    New-Item -ItemType Directory -Force -Path $destDir | Out-Null
}

# Add System.Drawing assembly
Add-Type -AssemblyName System.Drawing

try {
    $img = [System.Drawing.Image]::FromFile($source)
    Write-Host "Loaded source image of size $($img.Width)x$($img.Height)"
    
    # Helper to resize and save
    function Resize-And-Save {
        param(
            [int]$w,
            [int]$h,
            [string]$name
        )
        $bmp = New-Object System.Drawing.Bitmap($w, $h)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        
        # High quality scaling
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        
        # Draw original image stretched to target boundaries
        $g.DrawImage($img, 0, 0, $w, $h)
        
        $targetPath = Join-Path $destDir $name
        $bmp.Save($targetPath, [System.Drawing.Imaging.ImageFormat]::Png)
        
        $g.Dispose()
        $bmp.Dispose()
        Write-Host "Generated $name"
    }
    
    # Generate the icons
    Resize-And-Save 16 16 "icon-16.png"
    Resize-And-Save 48 48 "icon-48.png"
    Resize-And-Save 128 128 "icon-128.png"
    
    # Generate promotional and screenshot placeholders
    Resize-And-Save 440 280 "promo-440x280.png"
    Resize-And-Save 1280 800 "screenshot.png"
    
    $img.Dispose()
    Write-Host "All assets generated successfully in $destDir"
} catch {
    Write-Error "Error scaling image: $_"
}
