# Copyright © 2026 Mathieu Lavigne. Tous droits réservés. Voir LICENSE.
"""Prépare les images des voyages créés depuis l'administration (exécuté par le robot GitHub).

1. Photo d'en-tête téléversée (_app/voyages/photos/<id>.jpg|png|webp) : recadrée en <id>/hero.webp
   (1400 × 467) et <id>/og.jpg (1200 × 630, aperçu des liens partagés). Refaite si la photo change.
2. Voyage sans photo ni hero.webp : illustration de montagne générée (même style que les icônes).
3. Icônes manquantes : générées par icones.py.
"""
import hashlib, json, pathlib, sys
from PIL import Image, ImageOps

APP = pathlib.Path(__file__).resolve().parent.parent
ROOT = APP.parent
sys.path.insert(0, str(APP / "icones"))
import icones

def cover(im, w, h):
    return ImageOps.fit(im.convert("RGB"), (w, h), method=Image.LANCZOS, centering=(0.5, 0.45))

def photos():
    for f in sorted((APP / "voyages" / "photos").glob("*")):
        if f.suffix.lower() not in (".jpg", ".jpeg", ".png", ".webp"):
            continue
        vid = f.stem
        out = ROOT / vid
        if not (APP / "voyages" / f"{vid}.json").exists():
            continue
        sha = hashlib.sha256(f.read_bytes()).hexdigest()
        fait = f.with_suffix(".fait")
        if fait.exists() and fait.read_text().strip() == sha and (out / "hero.webp").exists():
            continue
        out.mkdir(exist_ok=True)
        im = ImageOps.exif_transpose(Image.open(f))
        cover(im, 1400, 467).save(out / "hero.webp", "WEBP", quality=82)
        cover(im, 1200, 630).save(out / "og.jpg", "JPEG", quality=85)
        fait.write_text(sha + "\n")
        print(f"photo : {vid}")

def paysage_svg(crete, w, h):
    # la silhouette de l'icône, étirée en largeur, devant une deuxième chaîne plus pâle
    base = h * 0.9
    def pt(x, y, dx=0.0, k=1.0):
        hy = (icones.BASE - y) / (icones.BASE - 200) * h * 0.62 * k
        return f"{x / 1024 * w + dx:.0f},{base - hy:.0f}"
    pts = " ".join([f"0,{base:.0f}"] + [pt(x, y) for x, y in crete] + [f"{w},{base:.0f}"])
    loin = " ".join([f"0,{base:.0f}"] + [pt(x, y, w * 0.22, 0.78) for x, y in crete] + [pt(x, y, -w * 0.3, 0.7) for x, y in crete[1:-1]][:0] + [f"{w},{base:.0f}"])
    loin2 = " ".join([f"0,{base:.0f}"] + [pt(x, y, -w * 0.32, 0.7) for x, y in crete] + [f"{w},{base:.0f}"])
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">
<defs><linearGradient id="c" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2f78d6"/><stop offset=".75" stop-color="#13509f"/><stop offset="1" stop-color="#0a2c60"/></linearGradient>
<linearGradient id="n" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#8fb3e4"/></linearGradient></defs>
<rect width="{w}" height="{h}" fill="url(#c)"/>
<polygon points="{loin}" fill="#6c9ddd" opacity=".45"/>
<polygon points="{loin2}" fill="#6c9ddd" opacity=".35"/>
<polygon points="{pts}" fill="url(#n)"/>
<rect x="0" y="{base:.0f}" width="{w}" height="{h - base + 1:.0f}" fill="#0b2f66"/>
</svg>'''

def illustrations():
    todo = []
    for f in sorted((APP / "voyages").glob("*.json")):
        v = json.loads(f.read_text())
        if not (ROOT / v["id"] / "hero.webp").exists():
            todo.append((v["id"], icones.MONTAGNES.get(v["station"], icones.GENERIQUE)))
    if not todo:
        return
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
        pg = b.new_page()
        for vid, crete in todo:
            out = ROOT / vid
            out.mkdir(exist_ok=True)
            for nom, w, h in [("hero", 1400, 467), ("og", 1200, 630)]:
                pg.set_viewport_size({"width": w, "height": h})
                pg.set_content(f'<html><body style="margin:0">{paysage_svg(crete, w, h)}</body></html>')
                tmp = out / f".{nom}.png"
                pg.screenshot(path=str(tmp))
                im = Image.open(tmp).convert("RGB")
                im.save(out / ("hero.webp" if nom == "hero" else "og.jpg"), "WEBP" if nom == "hero" else "JPEG", quality=85)
                tmp.unlink()
            print(f"illustration : {vid}")
        b.close()

if __name__ == "__main__":
    photos()
    illustrations()
    icones.main("", manquantes=True)
