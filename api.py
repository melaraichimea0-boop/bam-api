# -*- coding: utf-8 -*-
"""
api.py — Serveur local BAM Courbe des Taux
Logique fidèle à TMP.py (scraping + interpolation linéaire)
Lancer : python api.py
Accès PC    : http://localhost:5000/ping
Accès téléphone (même WiFi) : http://192.168.X.X:5000/ping
"""

from flask import Flask, jsonify, request
from flask_cors import CORS
import requests
from bs4 import BeautifulSoup
import urllib.request
import csv
import io
import traceback
from datetime import datetime

app = Flask(__name__)

# ── CORS : autoriser TOUTES les origines (PC + téléphone + Claude.ai) ──
CORS(app, resources={r"/*": {"origins": "*"}})

# ── Maturités cibles (alignées sur votre Notebook + Excel) ──────────
L = [
    0.019444444444, # 1W
    0.041666666667, # 2W
    0.086111111111, # 1M
    0.166666666667, # 2M
    0.25,           # 3M
    0.5,            # 6M
    1,              # 1Y
    2,              # 2Y
    3,              # 3Y
    4,              # 4Y
    5,              # 5Y
    7,              # 7Y
    10,             # 10Y
    15,             # 15Y
    20,             # 20Y
    25,             # 25Y
    30,             # 30Y
]
MAT_LABELS = ["1J","1W","2W","1M","2M","3M","6M","1Y","2Y","3Y","4Y","5Y","7Y","10Y","15Y","20Y","25Y","30Y"]

HEADERS_HTTP = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "fr-FR,fr;q=0.9",
}


def scrape_bdt(jj, mm, aaaa):
    """
    Scrape la page BAM pour une date donnée.
    Retourne (h, n, raw_points) ou None si pas de données.
    """
    url = (
        "https://www.bkam.ma/Marches/Principaux-indicateurs/Marche-obligataire/"
        "Marche-des-bons-de-tresor/Marche-secondaire/Taux-de-reference-des-bons-du-tresor"
        "?date={0}%2F{1}%2F{2}&block=e1d6b9bbf87f86f8ba53e8518e882982"
    ).format(jj, mm, aaaa)

    print(f"  → Scraping URL: {url}")

    r = requests.get(url, timeout=30, headers=HEADERS_HTTP)
    print(f"  → Status HTTP: {r.status_code}")
    
    soup = BeautifulSoup(r.text, "html.parser")
    results = soup.find(title="Téléchargement CSV")

    if results is None:
        print("  → Lien CSV non trouvé (week-end / férié / hors plage)")
        return None

    # Télécharger le CSV
    link = results["href"]
    download_url = "https://www.bkam.ma" + link
    print(f"  → CSV URL: {download_url}")

    req = urllib.request.Request(download_url, headers=HEADERS_HTTP)
    response = urllib.request.urlopen(req, timeout=30)
    html = response.read()
    print(f"  → CSV téléchargé: {len(html)} bytes")

    # ── Essai UTF-8 puis latin-1 ──
    for encoding in ("utf-8", "latin-1", "cp1252"):
        try:
            raw_text = html.decode(encoding, errors="strict")
            break
        except Exception:
            raw_text = html.decode("latin-1", errors="replace")

    # Nettoyer le CSV
    cleaned_rows = []
    reader = csv.reader(io.StringIO(raw_text), delimiter=";")
    for row in reader:
        if row and row[0] not in (
            "Taux de référence des bons du Trésor",
            "Taux de r\u00e9f\u00e9rence des bons du Tr\u00e9sor",
            "En millions de dirhams",
            "Total",
            "",
        ):
            cleaned_rows.append(row)

    if not cleaned_rows:
        print("  → CSV vide après nettoyage")
        return None

    # Trouver les colonnes
    header = cleaned_rows[0]
    print(f"  → Colonnes CSV: {header}")

    def find_col(h, candidates):
        for cand in candidates:
            for i, col in enumerate(h):
                if cand.lower() in col.lower():
                    return i
        return None

    idx_echeance = find_col(header, ["Date d'échéance", "echeance", "échéance"])
    idx_valeur   = find_col(header, ["Date de la valeur", "valeur"])
    idx_taux     = find_col(header, ["Taux moyen pondéré", "Taux moyen", "taux"])

    if None in (idx_echeance, idx_valeur, idx_taux):
        print(f"  → Colonnes manquantes: éch={idx_echeance}, val={idx_valeur}, taux={idx_taux}")
        return None

    print(f"  → Colonnes: éch={idx_echeance}, val={idx_valeur}, taux={idx_taux}")

    h_raw, n_raw, raw_points = [], [], []

    for row in cleaned_rows[1:]:
        try:
            if len(row) <= max(idx_echeance, idx_valeur, idx_taux):
                continue
            d_ech  = datetime.strptime(row[idx_echeance].strip(), "%d/%m/%Y")
            d_val  = datetime.strptime(row[idx_valeur].strip(),   "%d/%m/%Y")
            taux_s = row[idx_taux].strip()
            # "2,4500 %" → 0.0245
            taux_clean = (
                taux_s
                .replace("\xa0", "")
                .replace(" ", "")
                .replace("%", "")
                .replace(",", ".")
                .strip()
            )
            taux_f = float(taux_clean) / 100
            mat    = (d_ech - d_val).days / 360.0

            h_raw.append(mat)
            n_raw.append(taux_f)
            raw_points.append({
                "mat_years":     round(mat, 6),
                "rate":          round(taux_f, 6),
                "date_echeance": row[idx_echeance].strip(),
                "taux_str":      taux_s,
            })
        except Exception as e:
            print(f"  → Ligne ignorée: {row} | erreur: {e}")
            continue

    if not h_raw:
        print("  → Aucune ligne parsée")
        return None

    print(f"  → {len(h_raw)} points bruts extraits")

    # Tri par maturité
    combined = sorted(zip(h_raw, n_raw))
    h_raw, n_raw = zip(*combined)
    h_raw, n_raw = list(h_raw), list(n_raw)

    return h_raw, n_raw, raw_points


def interpolate(h, n):
    """Interpolation linéaire avec extrapolation plate (Portage exact de votre Notebook)"""
    result = []
    
    for Li in L:
        if Li <= h[0]:
            # Extrapolation plate au début
            result.append(round(n[0], 6))
        elif Li >= h[-1]:
            # Extrapolation plate à la fin
            result.append(round(n[-1], 6))
        else:
            # Interpolation linéaire classique
            for i in range(1, len(h)):
                if h[i-1] <= Li <= h[i]:
                    val = n[i-1] + (n[i] - n[i-1]) * (Li - h[i-1]) / (h[i] - h[i-1])
                    result.append(round(val, 6))
                    break
                    
    print(f"  → Interpolation terminée : {len(result)} points")
    return result


def scrape_overnight(jj, mm, aaaa):
    """Scrape le taux overnight interbancaire"""
    try:
        url = (
            "http://www.bkam.ma/Marches/Principaux-indicateurs/Marche-monetaire/"
            "Marche-monetaire-interbancaire?startDate={0}%2F{1}%2F{2}"
            "&endDate={0}%2F{1}%2F{2}"
            "&block=ae14ce1a4ee29af53d5645f51bf0e97d"
            "&sort=col1,asc"
        ).format(jj, mm, aaaa)
        r = requests.get(url, timeout=15, headers=HEADERS_HTTP)
        soup = BeautifulSoup(r.text, "html.parser")
        result = soup.find("span", {"class": "number"})
        if result:
            val = float(
                result.text.replace(",", ".").replace("\xa0", "").strip().rstrip("%")
            ) / 100
            print(f"  → Overnight: {val:.4%}")
            return round(val, 6)
    except Exception as e:
        print(f"  → Overnight scraping échoué: {e}")
    return 0.0225


# ── Routes Flask ──────────────────────────────────────────────────────

@app.after_request
def add_cors_headers(response):
    """S'assure que les headers CORS sont présents sur toutes les réponses"""
    response.headers["Access-Control-Allow-Origin"]  = "*"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    response.headers["Access-Control-Allow-Methods"] = "GET, OPTIONS"
    return response


@app.route("/courbe", methods=["GET", "OPTIONS"])
def courbe():
    if request.method == "OPTIONS":
        return "", 204

    date_str = request.args.get("date", "")
    print(f"\n{'='*50}")
    print(f"  /courbe appelé — date: {date_str}")

    if not date_str:
        return jsonify({"error": "Paramètre date manquant (format: YYYY-MM-DD)"}), 400

    try:
        d = datetime.strptime(date_str, "%Y-%m-%d")
    except ValueError:
        return jsonify({"error": "Format date invalide. Utiliser YYYY-MM-DD"}), 400

    jj, mm, aaaa = d.day, d.month, d.year

    scrape_result = scrape_bdt(jj, mm, aaaa)

    if scrape_result is None:
        print("  → Résultat: AUCUNE DONNÉE")
        return jsonify({
            "date":       date_str,
            "found":      False,
            "message":    "Aucune donnée disponible pour cette date (week-end, férié ou hors plage).",
            "rates":      [],
            "labels":     MAT_LABELS,
            "raw_points": [],
            "overnight":  None,
        })

    h, n, raw_points = scrape_result
    interp    = interpolate(h, n)
    overnight = scrape_overnight(jj, mm, aaaa)

    print(f"  → Résultat: OK — {len(raw_points)} points bruts, taux[6]={interp[6]}")
    
    # On insère l'Overnight au début pour que "1J" = Overnight (comme dans votre Excel)
    final_rates = [overnight] + interp

    return jsonify({
        "date":       date_str,
        "found":      True,
        "labels":     MAT_LABELS,
        "L_years":    L,
        "rates":      final_rates,
        "raw_points": raw_points,
        "overnight":  overnight,
        "source":     "bkam.ma",
    })


@app.route("/ping", methods=["GET"])
def ping():
    return jsonify({"status": "ok", "message": "Serveur BAM opérationnel ✅"})


if __name__ == "__main__":
    print("=" * 55)
    print("  SERVEUR BAM — Courbe des Taux BDT")
    print("  Accès local  : http://localhost:5000/ping")
    print("  Accès réseau : http://0.0.0.0:5000/ping")
    print("  (utilisez votre IP WiFi depuis le téléphone)")
    print("=" * 55)
    app.run(host="0.0.0.0", port=5000, debug=True)
