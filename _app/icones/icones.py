"""Icônes des apps de voyage (écran d'accueil).

Pour chaque voyage de _app/voyages/*.json : une montagne propre à la station, le nom de la
station et l'année. Produit dans le dossier du voyage : icon-192.png, icon-512.png,
icon-maskable-512.png (zone sûre Android) et apple-touch-icon.png (180 px, iPhone).

    python3 _app/icones/icones.py            # tous les voyages
    python3 _app/icones/icones.py zermatt    # seulement les voyages dont l'id contient « zermatt »
    python3 _app/icones/icones.py --manquantes   # seulement les voyages qui n'ont pas encore d'icône

Rendu par Chrome (Playwright) avec la police Inter. Les SVG sources sont gardés dans _app/icones/.
Pour une nouvelle station, ajoutez son profil de montagne dans MONTAGNES (sinon : profil générique).
"""
import json, sys, re, pathlib
from playwright.sync_api import sync_playwright

APP = pathlib.Path(__file__).resolve().parent.parent
ROOT = APP.parent
BASE = 760  # ligne de base des montagnes (sur 1024)

# Silhouettes (points de la crête, de gauche à droite, sur une toile de 1024).
MONTAGNES = {
    # Sölden : le massif du Gaislachkogl, deux sommets
    "soelden": [(90, BASE), (330, 450), (420, 520), (575, 300), (700, 450), (760, 410), (934, BASE)],
    # St. Anton : la crête dentelée de la Valluga
    "stanton": [(90, BASE), (240, 520), (310, 570), (420, 350), (500, 450), (585, 380), (690, 530), (770, 470), (934, BASE)],
    # Zermatt : la pyramide du Cervin
    "zermatt": [(140, BASE), (350, 590), (462, 420), (498, 250), (536, 232), (566, 262), (612, 430), (724, 585), (884, BASE)],
}
GENERIQUE = [(90, BASE), (300, 480), (400, 560), (540, 320), (700, 520), (934, BASE)]


def svg(nom, annee, crete, echelle=1.0):
    pts = " ".join(f"{x},{y}" for x, y in crete)
    # Ombres : de chaque sommet vers le creux suivant, côté droit
    ombres = []
    for i in range(1, len(crete) - 1):
        (px, py), (ax, ay), (bx, by) = crete[i], crete[i - 1], crete[i + 1]
        if py < ay and py < by:  # sommet local
            j = i + 1
            while j < len(crete) - 1 and crete[j + 1][1] > crete[j][1]:
                j += 1
            vx, vy = crete[j]
            arete = " ".join(f"{x},{y}" for x, y in crete[i:j + 1])
            ombres.append(f"{arete} {vx},{BASE} {px + (vx - px) * 0.45:.0f},{BASE}")
    om = "".join(f'<polygon points="{o}" fill="url(#ombre)"/>' for o in ombres)
    taille = 150 if len(nom) <= 7 else int(150 * 7.4 / len(nom))
    t = f"translate(512 512) scale({echelle}) translate(-512 -512)"
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
<defs>
<linearGradient id="ciel" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2f78d6"/><stop offset=".62" stop-color="#13509f"/><stop offset="1" stop-color="#0a2c60"/></linearGradient>
<linearGradient id="neige" gradientUnits="userSpaceOnUse" x1="0" y1="230" x2="0" y2="{BASE}"><stop offset="0" stop-color="#ffffff"/><stop offset=".55" stop-color="#e9f1fb"/><stop offset="1" stop-color="#7fa8de"/></linearGradient>
<linearGradient id="ombre" gradientUnits="userSpaceOnUse" x1="0" y1="230" x2="0" y2="{BASE}"><stop offset="0" stop-color="#8eb0e0" stop-opacity=".95"/><stop offset=".6" stop-color="#6f97d2" stop-opacity=".55"/><stop offset="1" stop-color="#3f6fb8" stop-opacity="0"/></linearGradient>
<linearGradient id="sol" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0c3570" stop-opacity="0"/><stop offset=".22" stop-color="#0b2f66"/><stop offset="1" stop-color="#08244f"/></linearGradient>
</defs>
<rect width="1024" height="1024" fill="url(#ciel)"/>
<g transform="{t}">
<polygon points="{pts}" fill="url(#neige)"/>
{om}
</g>
<rect x="0" y="{512 + (BASE - 90 - 512) * echelle:.0f}" width="1024" height="1024" fill="url(#sol)"/>
<g transform="{t}">
<text x="512" y="{BASE + 150}" text-anchor="middle" font-family="Inter" font-weight="800" font-size="{taille}" letter-spacing="-3" fill="#ffffff">{nom}</text>
<text x="512" y="{BASE + 222}" text-anchor="middle" font-family="Inter" font-weight="600" font-size="58" letter-spacing="14" fill="#a9c8f0">{annee}</text>
</g>
</svg>'''


def main(filtre=None, manquantes=False):
    if filtre is None:
        args = [a for a in sys.argv[1:] if not a.startswith("--")]
        filtre = args[0] if args else ""
        manquantes = "--manquantes" in sys.argv
    voyages = []
    for f in sorted((APP / "voyages").glob("*.json")):
        v = json.loads(f.read_text())
        if filtre and filtre not in v["id"]:
            continue
        if manquantes and (ROOT / v["id"] / "icon-512.png").exists():
            continue
        st = json.loads((APP / "stations" / f"{v['station']}.json").read_text())
        nom = v.get("iconeNom") or st["nom"]
        annee = v.get("iconeAnnee") or (re.search(r"20\d\d", v.get("dates", "") + v["id"]) or [""])[0]
        voyages.append((v["id"], nom, annee, MONTAGNES.get(v["station"], GENERIQUE)))
    if not voyages:
        return
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
        pg = b.new_page(viewport={"width": 1024, "height": 1024})
        for vid, nom, annee, crete in voyages:
            out = ROOT / vid
            out.mkdir(exist_ok=True)
            for nomf, ech, px in [("icon-512.png", 1.0, 512), ("icon-192.png", 1.0, 192), ("apple-touch-icon.png", 1.0, 180), ("icon-maskable-512.png", 0.8, 512)]:
                s = svg(nom, annee, crete, ech)
                if ech == 1.0:
                    (APP / "icones" / f"{vid}.svg").write_text(s)
                pg.set_viewport_size({"width": px, "height": px})
                inline = s.replace('width="1024" height="1024"', f'width="{px}" height="{px}" style="display:block"', 1)
                pg.set_content(f'<html><head><meta charset="utf-8"></head><body style="margin:0">{inline}</body></html>')
                pg.wait_for_timeout(150)
                pg.screenshot(path=str(out / nomf), omit_background=False)
            print(f"{vid} : {nom} {annee}")
        b.close()


if __name__ == "__main__":
    main()
