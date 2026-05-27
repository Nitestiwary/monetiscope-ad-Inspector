import os
import sys
import subprocess

def install_and_import(package):
    try:
        import PIL
    except ImportError:
        print(f"PIL not found, installing {package}...")
        subprocess.check_call([sys.executable, "-m", "pip", "install", package])

# Ensure Pillow is installed
install_and_import("Pillow")

from PIL import Image, ImageOps

def generate_assets(source_path, dest_dir):
    if not os.path.exists(source_path):
        print(f"Error: Source image not found at {source_path}")
        return False
        
    os.makedirs(dest_dir, exist_ok=True)
    
    try:
        # Load high-res image
        img = Image.open(source_path)
        print(f"Loaded source image {source_path} ({img.width}x{img.height})")
        
        # 1. 16x16 icon
        img_16 = img.resize((16, 16), Image.Resampling.LANCZOS)
        img_16.save(os.path.join(dest_dir, "icon-16.png"), "PNG")
        print("Generated icon-16.png")
        
        # 2. 48x48 icon
        img_48 = img.resize((48, 48), Image.Resampling.LANCZOS)
        img_48.save(os.path.join(dest_dir, "icon-48.png"), "PNG")
        print("Generated icon-48.png")
        
        # 3. 128x128 icon
        img_128 = img.resize((128, 128), Image.Resampling.LANCZOS)
        img_128.save(os.path.join(dest_dir, "icon-128.png"), "PNG")
        print("Generated icon-128.png")
        
        # 4. Promo tile (440x280) - center the logo on a dark background or pad it nicely
        promo = Image.new("RGBA", (440, 280), (18, 24, 38, 255)) # Dark navy background
        logo_resized = img.resize((200, 200), Image.Resampling.LANCZOS)
        promo.paste(logo_resized, (120, 40), logo_resized.convert("RGBA") if logo_resized.mode in ("RGBA", "LA") else None)
        promo.save(os.path.join(dest_dir, "promo-440x280.png"), "PNG")
        print("Generated promo-440x280.png")
        
        # 5. Screenshot (1280x800 mockup or 640x400 CWS size)
        screenshot = Image.new("RGBA", (1280, 800), (18, 24, 38, 255))
        logo_resized_large = img.resize((400, 400), Image.Resampling.LANCZOS)
        screenshot.paste(logo_resized_large, (440, 200), logo_resized_large.convert("RGBA") if logo_resized_large.mode in ("RGBA", "LA") else None)
        screenshot.save(os.path.join(dest_dir, "screenshot.png"), "PNG")
        print("Generated screenshot.png")
        
        print("\nAll assets generated successfully in:", dest_dir)
        return True
    except Exception as e:
        print(f"Error generating assets: {e}")
        return False

if __name__ == "__main__":
    source = r"C:\Users\Nitesh Kumar\.gemini\antigravity\brain\0117b47d-8940-4d4a-affa-b6677de8337e\media__1779893562567.jpg"
    dest = r"C:\Users\Nitesh Kumar\.gemini\antigravity\scratch\monetiscope-ad-inspector\assets"
    generate_assets(source, dest)
