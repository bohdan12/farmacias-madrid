#!/usr/bin/env python3
"""Genera site/data/farmacias.json.

Farmacias de Madrid capital (municipio "Madrid") certificadas por el COFM para
elaborar fórmulas magistrales, con coordenadas (registro de la Comunidad de
Madrid) y calendario de guardias (Ayuntamiento de Madrid).

Uso:
    python3 -I scripts/farmacias/build_data.py [--cache-dir DIR] [--use-cache]
                                               [--out FICHERO] [--today AAAA-MM-DD]

Requisitos: Python 3 (solo biblioteca estándar), `curl` y `pdftotext` (poppler-utils).
"""

import argparse
import csv
import datetime as dt
import io
import json
import math
import os
import re
import subprocess
import sys
import tempfile
from collections import Counter, defaultdict
from html.parser import HTMLParser
from urllib.parse import urljoin

USER_AGENT = "farmacias-madrid-build/1.0"

COFM_PAGE = "https://www.cofm.es/es/transparencia/listados-de-farmacias-formuladoras/"
COFM_PUBLISHER = "Colegio Oficial de Farmacéuticos de Madrid (COFM)"
# Respaldo si no se puede extraer el enlace de la página (cambian cada mes).
FALLBACK_PDF_CERT = ("https://www.cofm.es/resources/doc/portal/2026/10/08/"
                     "farmacias-certificadas-octubre-2026.pdf")
FALLBACK_PDF_TERCEROS = ("https://www.cofm.es/resources/doc/portal/2026/10/08/"
                         "farmacias-certificadas-a-terceros.pdf")
REGISTRO_URL = ("https://datos.comunidad.madrid/dataset/2d682b1d-e2e8-4c6f-b902-7a3f108e2fb9/"
                "resource/904a161b-f339-4296-be61-1ae914494c89/download/oficinas_farmacia.csv")
GUARDIAS_URL = ("https://datos.madrid.es/dataset/214440-0-farmacias-guardia/resource/"
                "214440-3-farmacias-guardia-csv/download/214440-0-farmacias-guardia-xlsx.csv")

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_OUT = os.path.join(REPO_ROOT, "site", "data", "farmacias.json")

# Caja aproximada del término municipal de Madrid (comprobación de cordura).
MADRID_BBOX = (40.30, 40.65, -3.90, -3.50)  # lat_min, lat_max, lng_min, lng_max


class BuildError(Exception):
    pass


def log(msg):
    print(msg, file=sys.stderr)


# --------------------------------------------------------------------------
# Descargas
# --------------------------------------------------------------------------

def download(url, dest, use_cache):
    if use_cache and os.path.exists(dest) and os.path.getsize(dest) > 0:
        log(f"  (caché) {url}")
        return dest
    log(f"  descargando {url}")
    tmp = dest + ".part"
    cmd = ["curl", "-sS", "-L", "--fail", "--retry", "3", "--max-time", "300",
           "-A", USER_AGENT, "-o", tmp, url]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise BuildError(f"Fallo al descargar {url}: {res.stderr.strip()}")
    os.replace(tmp, dest)
    return dest


class _LinkParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            href = dict(attrs).get("href")
            if href:
                self.links.append(href)


def find_pdf_links(page_path):
    """Devuelve (url_certificadas, url_terceros) a partir de la página del COFM."""
    with open(page_path, encoding="utf-8", errors="replace") as fh:
        html = fh.read()
    p = _LinkParser()
    p.feed(html)
    pdfs = [urljoin(COFM_PAGE, h) for h in p.links if h.lower().split("?")[0].endswith(".pdf")]
    cert = [u for u in pdfs if "certificad" in u.lower() and "tercero" not in u.lower()]
    terc = [u for u in pdfs if "tercero" in u.lower()]
    return (cert[0] if cert else None), (terc[0] if terc else None)


# --------------------------------------------------------------------------
# PDF del COFM
# --------------------------------------------------------------------------

RE_OF = re.compile(r"^\s*OF-(\d+)\s+(.*\S)\s*$")
RE_ADDR_CP = re.compile(r"^(.*\S)\s+-\s+(\d{5})\s+(.+)$")   # último " - CP Municipio"
RE_ADDR_NOCP = re.compile(r"^(.*\S)\s+-\s+(\D.*)$")          # " - Municipio" sin CP
RE_TOTAL = re.compile(r"Número de oficinas de farmacia\s+(\w+)\s*=\s*(\d+)")
RE_UPDATED = re.compile(r"Fecha actualizaci[oó]n\s+(\d{2})/(\d{2})/(\d{2,4})")
RE_FOOTER = re.compile(r"^\s*(Fecha actualizaci[oó]n\s+\d|Página\s+\d+\s+de\s+\d+)")
RE_NE = re.compile(r"^\s*No estériles\b(.*)$")
RE_ES = re.compile(r"^\s*Estériles\b(.*)$")
RE_OTROS = re.compile(r"^\s*Otros(?: no)?\s*$")          # etiqueta "Otros" / "Otros no"
RE_EST_LOWER = re.compile(r"^\s*estériles\b(.*)$")      # 2.ª línea de la etiqueta


def pdf_to_text(pdf_path):
    res = subprocess.run(["pdftotext", "-layout", "-enc", "UTF-8", pdf_path, "-"],
                         capture_output=True)
    if res.returncode != 0:
        raise BuildError(f"pdftotext falló con {pdf_path}: {res.stderr.decode(errors='replace')}")
    # Los saltos de página (\f) se pegan al comienzo de la línea siguiente.
    return res.stdout.decode("utf-8").replace("\f", "\n")


def _split_forms(s):
    s = s.strip()
    return [f for f in re.split(r"\s+", s) if f] if s else []


def parse_cofm_pdf(pdf_path):
    """Analiza el PDF del COFM. Devuelve (entradas, total_declarado, fecha_actualizacion)."""
    text = pdf_to_text(pdf_path)
    lines = text.split("\n")

    m = RE_TOTAL.search(text)
    if not m:
        raise BuildError(f"{pdf_path}: no se encuentra 'Número de oficinas de farmacia ... = N'")
    declared = int(m.group(2))
    mu = RE_UPDATED.search(text)
    updated = None
    if mu:
        d, mo, y = mu.groups()
        y = int(y) + (2000 if len(y) == 2 else 0)
        updated = dt.date(y, int(mo), int(d)).isoformat()

    # Agrupar líneas por entrada OF-xxxxx
    blocks = []
    for line in lines:
        mo = RE_OF.match(line)
        if mo:
            blocks.append({"of": int(mo.group(1)), "head": mo.group(2), "body": []})
        elif blocks:
            blocks[-1]["body"].append(line)

    entries = []
    for b in blocks:
        head = re.sub(r"\s+", " ", b["head"])
        body = [l for l in b["body"] if l.strip() and not RE_FOOTER.match(l)]
        # Dirección partida en varias líneas: unir líneas anteriores a "No estériles"
        i = 0
        while i < len(body) and not RE_NE.match(body[i]) and not RE_ADDR_CP.match(head):
            head = head + " " + body[i].strip()
            i += 1
        body = body[i:]

        m = RE_ADDR_CP.match(head)
        if m:
            address, cp, town = m.group(1), m.group(2), m.group(3)
        else:
            m = RE_ADDR_NOCP.match(head)
            if not m:
                raise BuildError(f"OF-{b['of']:05d}: dirección no reconocida: {head!r}")
            address, cp, town = m.group(1), None, m.group(2)

        formas = {"noEsteriles": [], "otrosNoEsteriles": [], "esteriles": [], "otrosEsteriles": []}
        state = None
        seen_es = False
        for l in body:
            mn = RE_NE.match(l)
            me = RE_ES.match(l)
            if mn:
                state = "noEsteriles"
                formas[state] += _split_forms(mn.group(1))
            elif me:
                state = "esteriles"
                seen_es = True
                formas[state] += _split_forms(me.group(1))
            elif RE_OTROS.match(l):
                # El PDF de terceros etiqueta a veces "Otros estériles" como "Otros no".
                state = "otrosEsteriles" if seen_es else "otrosNoEsteriles"
            elif RE_EST_LOWER.match(l):
                rest = RE_EST_LOWER.match(l).group(1).strip()
                if rest and state and state.startswith("otros"):
                    formas[state].append(rest)
            else:
                # Línea sin etiqueta: texto libre de "Otros ..." (la etiqueta de dos
                # líneas queda centrada verticalmente respecto al texto).
                txt = l.strip()
                state = {"noEsteriles": "otrosNoEsteriles", "esteriles": "otrosEsteriles",
                         None: "otrosNoEsteriles"}.get(state, state)
                formas[state].append(txt)
        # Las listas de formas son palabras sueltas; una coma indicaría un error de análisis.
        for k in ("noEsteriles", "esteriles"):
            bad = [f for f in formas[k] if "," in f]
            if bad:
                raise BuildError(f"OF-{b['of']:05d}: formas inesperadas en {k}: {bad}")
        out = {
            "soe": b["of"],
            "address": re.sub(r"\s+", " ", address).strip(),
            "cp": cp,
            "town": re.sub(r"\s+", " ", town).strip(),
            "formas": {
                "noEsteriles": formas["noEsteriles"],
                "otrosNoEsteriles": " ".join(formas["otrosNoEsteriles"]).strip(),
                "esteriles": formas["esteriles"],
                "otrosEsteriles": " ".join(formas["otrosEsteriles"]).strip(),
            },
        }
        entries.append(out)

    if len(entries) != declared:
        raise BuildError(f"{os.path.basename(pdf_path)}: {len(entries)} entradas analizadas, "
                         f"pero la cabecera declara {declared}")
    dup = [k for k, v in Counter(e["soe"] for e in entries).items() if v > 1]
    if dup:
        raise BuildError(f"{os.path.basename(pdf_path)}: números OF duplicados: {dup}")
    return entries, declared, updated


# --------------------------------------------------------------------------
# UTM (ETRS89 / UTM 30N, EPSG:25830) -> WGS84 geográficas
# --------------------------------------------------------------------------
# Serie de Krüger (Transverse Mercator), elipsoide GRS80. Precisión sub-milimétrica
# dentro de la zona; ETRS89 y WGS84 se consideran equivalentes a efectos de mapa.

_A = 6378137.0
_F = 1 / 298.257222101
_K0 = 0.9996
_E0 = 500000.0
_N0 = 0.0
_N = _F / (2 - _F)
_AA = _A / (1 + _N) * (1 + _N**2 / 4 + _N**4 / 64 + _N**6 / 256)
_BETA = (
    _N / 2 - 2 * _N**2 / 3 + 37 * _N**3 / 96 - _N**4 / 360 - 81 * _N**5 / 512,
    _N**2 / 48 + _N**3 / 15 - 437 * _N**4 / 1440 + 46 * _N**5 / 105,
    17 * _N**3 / 480 - 37 * _N**4 / 840 - 209 * _N**5 / 4480,
    4397 * _N**4 / 161280 - 11 * _N**5 / 504,
    4583 * _N**5 / 161280,
)
_DELTA = (
    2 * _N - 2 * _N**2 / 3 - 2 * _N**3 + 116 * _N**4 / 45 + 26 * _N**5 / 45,
    7 * _N**2 / 3 - 8 * _N**3 / 5 - 227 * _N**4 / 45 + 2704 * _N**5 / 315,
    56 * _N**3 / 15 - 136 * _N**4 / 35 - 1262 * _N**5 / 105,
    4279 * _N**4 / 630 - 332 * _N**5 / 35,
    4174 * _N**5 / 315,
)


def utm_to_wgs84(easting, northing, zone=30):
    lon0 = math.radians(zone * 6 - 183)
    xi = (northing - _N0) / (_K0 * _AA)
    eta = (easting - _E0) / (_K0 * _AA)
    xip, etap = xi, eta
    for j, b in enumerate(_BETA, start=1):
        xip -= b * math.sin(2 * j * xi) * math.cosh(2 * j * eta)
        etap -= b * math.cos(2 * j * xi) * math.sinh(2 * j * eta)
    chi = math.asin(math.sin(xip) / math.cosh(etap))
    lat = chi + sum(d * math.sin(2 * j * chi) for j, d in enumerate(_DELTA, start=1))
    lon = lon0 + math.atan2(math.sinh(etap), math.cos(xip))
    return math.degrees(lat), math.degrees(lon)


# --------------------------------------------------------------------------
# CSV
# --------------------------------------------------------------------------

def read_csv(path):
    with open(path, "rb") as fh:
        raw = fh.read()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("cp1252")
    return list(csv.DictReader(io.StringIO(text), delimiter=";"))


def _num(s):
    s = (s or "").strip().replace(".", "").replace(",", ".") if "," in (s or "") else (s or "").strip()
    return float(s) if s else None


def parse_registro(path):
    rows = read_csv(path)
    need = {"FARMACIA_NRO_SOE", "MUNICIPIO_NOMBRE", "LOCALIZACION_COORDENADA_X",
            "LOCALIZACION_COORDENADA_Y"}
    if not rows or not need.issubset(rows[0].keys()):
        raise BuildError(f"Registro: columnas inesperadas {list(rows[0].keys()) if rows else []}")
    reg = {}
    for r in rows:
        soe = (r["FARMACIA_NRO_SOE"] or "").strip()
        if not soe.isdigit():
            continue
        # TITULARES_NOMBRE (nombres de personas) se ignora deliberadamente.
        reg[int(soe)] = {
            "municipio": (r["MUNICIPIO_NOMBRE"] or "").strip(),
            "x": _num(r["LOCALIZACION_COORDENADA_X"]),
            "y": _num(r["LOCALIZACION_COORDENADA_Y"]),
        }
    return reg


RE_DURACION = re.compile(r"\((\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*H?\b(.*?)\)", re.I)


def parse_duracion(label):
    m = RE_DURACION.search(label)
    if not m:
        raise BuildError(f"Guardias: duración no reconocida: {label!r}")
    h1, m1, h2, m2, tail = m.groups()
    start = f"{int(h1):02d}:{m1}"
    end = f"{int(h2):02d}:{m2}"
    next_day = bool(re.search(r"SIGUIENTE", tail, re.I)) or (int(h2), int(m2)) <= (int(h1), int(m1))
    return {"start": start, "end": end, "nextDay": next_day, "label": label}


def parse_guardias(path):
    rows = read_csv(path)
    need = {"Municipio", "Barrio", "Fecha", "Farmacia", "Duración", "Teléfono"}
    if not rows or not need.issubset(rows[0].keys()):
        raise BuildError(f"Guardias: columnas inesperadas {list(rows[0].keys()) if rows else []}")
    by_soe = defaultdict(dict)
    phones = defaultdict(list)    # (fecha, teléfono)
    barrios = defaultdict(Counter)
    dates = set()
    dur_cache = {}
    skipped = 0
    for r in rows:
        soe = (r["Farmacia"] or "").strip()
        fecha = (r["Fecha"] or "").strip()
        if not soe.isdigit() or not fecha:
            skipped += 1
            continue
        if (r["Municipio"] or "").strip().upper() != "MADRID":
            skipped += 1
            continue
        d = dt.datetime.strptime(fecha, "%d/%m/%Y").date().isoformat()
        label = re.sub(r"\s+", " ", (r["Duración"] or "").strip())
        if label not in dur_cache:
            dur_cache[label] = parse_duracion(label)
        soe = int(soe)
        prev = by_soe[soe].get(d)
        if prev and prev["label"] != label:
            log(f"  AVISO: SOE {soe} tiene dos guardias distintas el {d}; se conserva la de 24 h/más larga")
            if "24" in prev["label"]:
                continue
        by_soe[soe][d] = dict(dur_cache[label])
        dates.add(d)
        tel = re.sub(r"\D", "", r["Teléfono"] or "")
        if tel:
            phones[soe].append((d, tel))
        b = (r["Barrio"] or "").strip()
        if b:
            barrios[soe][b] += 1
    phone = {s: max(v)[1] for s, v in phones.items()}  # el de la fecha más reciente
    barrio = {s: c.most_common(1)[0][0] for s, c in barrios.items()}
    return by_soe, phone, barrio, (min(dates), max(dates)) if dates else (None, None), dur_cache, skipped


# --------------------------------------------------------------------------
# Principal
# --------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cache-dir", default=os.path.join(tempfile.gettempdir(), "farmacias-madrid-build"),
                    help="directorio para las descargas (por defecto, uno temporal del sistema)")
    ap.add_argument("--use-cache", action="store_true",
                    help="reutilizar ficheros ya descargados en --cache-dir")
    ap.add_argument("--out", default=DEFAULT_OUT, help="fichero JSON de salida")
    ap.add_argument("--today", default=dt.date.today().isoformat(),
                    help="fecha para las estadísticas del resumen (AAAA-MM-DD)")
    args = ap.parse_args()

    os.makedirs(args.cache_dir, exist_ok=True)
    c = lambda name: os.path.join(args.cache_dir, name)

    log("1. Página del COFM")
    url_cert, url_terc = None, None
    try:
        download(COFM_PAGE, c("cofm_listados.html"), args.use_cache)
        url_cert, url_terc = find_pdf_links(c("cofm_listados.html"))
    except BuildError as e:
        log(f"  AVISO: {e}")
    if not url_cert:
        log(f"  AVISO: enlace del PDF de certificadas no encontrado; se usa {FALLBACK_PDF_CERT}")
        url_cert = FALLBACK_PDF_CERT
    if not url_terc:
        log(f"  AVISO: enlace del PDF de terceros no encontrado; se usa {FALLBACK_PDF_TERCEROS}")
        url_terc = FALLBACK_PDF_TERCEROS
    log(f"  certificadas: {url_cert}\n  terceros:     {url_terc}")

    log("2. Descargas")
    pdf_cert = download(url_cert, c("certificadas.pdf"), args.use_cache)
    pdf_terc = download(url_terc, c("terceros.pdf"), args.use_cache)
    reg_csv = download(REGISTRO_URL, c("oficinas_farmacia.csv"), args.use_cache)
    gua_csv = download(GUARDIAS_URL, c("farmacias_guardia.csv"), args.use_cache)

    log("3. Análisis")
    cert, cert_total, cert_updated = parse_cofm_pdf(pdf_cert)
    terc, terc_total, terc_updated = parse_cofm_pdf(pdf_terc)
    terc_soe = {e["soe"] for e in terc}
    registro = parse_registro(reg_csv)
    guardias, phones, barrios, (g_from, g_to), durations, g_skipped = parse_guardias(gua_csv)
    log(f"  PDF certificadas: {cert_total} (actualizado {cert_updated}); "
        f"terceros: {terc_total} (actualizado {terc_updated})")
    log(f"  registro: {len(registro)} farmacias; guardias: {sum(len(v) for v in guardias.values())} "
        f"filas útiles de {g_from} a {g_to} ({g_skipped} descartadas)")
    log("  duraciones: " + "; ".join(f"{k} -> {v['start']}-{v['end']}{' (+1)' if v['nextDay'] else ''}"
                                     for k, v in sorted(durations.items())))

    anomalies = []
    pharmacies = []
    no_coords = []
    for e in sorted(cert, key=lambda e: e["soe"]):
        reg = registro.get(e["soe"])
        town_pdf = e["town"].strip().lower() == "madrid"
        town_reg = reg is not None and reg["municipio"] == "Madrid"
        if town_pdf != town_reg:
            anomalies.append(f"SOE {e['soe']}: municipio PDF={e['town']!r}, "
                             f"registro={reg['municipio'] if reg else 'NO ENCONTRADO'!r}")
        if not town_pdf:
            continue    # sólo Madrid capital (según el PDF del COFM)
        if e["cp"] and not e["cp"].startswith("280"):
            anomalies.append(f"SOE {e['soe']}: CP {e['cp']} fuera de Madrid capital")
        lat = lng = None
        if reg and reg["x"] and reg["y"]:
            lat, lng = utm_to_wgs84(reg["x"], reg["y"])
            lat, lng = round(lat, 6), round(lng, 6)
            if not (MADRID_BBOX[0] <= lat <= MADRID_BBOX[1] and MADRID_BBOX[2] <= lng <= MADRID_BBOX[3]):
                anomalies.append(f"SOE {e['soe']}: coordenadas fuera de Madrid ({lat}, {lng}); se anulan")
                lat = lng = None
        if lat is None:
            no_coords.append(e["soe"])
        g = guardias.get(e["soe"], {})
        pharmacies.append({
            "soe": e["soe"],
            "address": e["address"],
            "cp": e["cp"],
            "lat": lat,
            "lng": lng,
            "phone": phones.get(e["soe"]),
            "barrio": barrios.get(e["soe"]),
            "formas": e["formas"],
            "terceros": e["soe"] in terc_soe,
            "guardias": {d: g[d] for d in sorted(g)},
        })

    out = {
        "generated": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "sources": {
            "formulacion": {"url": url_cert, "page": COFM_PAGE, "updated": cert_updated,
                            "publisher": COFM_PUBLISHER},
            "formulacionTerceros": {"url": url_terc, "updated": terc_updated},
            "registro": {"url": REGISTRO_URL, "publisher": "Comunidad de Madrid", "license": "CC BY 4.0"},
            "guardias": {"url": GUARDIAS_URL,
                         "publisher": "Ayuntamiento de Madrid (datos.madrid.es), fuente COFM",
                         "license": "CC BY 4.0", "from": g_from, "to": g_to},
        },
        "pharmacies": pharmacies,
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    tmp = args.out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, args.out)

    # Resumen
    gdates = set()
    for g in guardias.values():
        gdates |= set(g)
    gdates = sorted(gdates)
    is24 = lambda v: v["nextDay"] and v["start"] == v["end"]
    today = args.today
    perm24 = [p["soe"] for p in pharmacies
              if gdates and all(d in p["guardias"] and is24(p["guardias"][d]) for d in gdates)]
    terc_madrid = sum(p["terceros"] for p in pharmacies)
    terc_not_in_cert = sorted(terc_soe - {e["soe"] for e in cert})
    print(f"Escrito {args.out} ({os.path.getsize(args.out)} bytes)")
    print(f"PDF certificadas: {cert_total} | Madrid capital: {len(pharmacies)} | "
          f"con coordenadas: {len(pharmacies) - len(no_coords)} | "
          f"con alguna guardia: {sum(1 for p in pharmacies if p['guardias'])} | "
          f"autorizadas a terceros (Madrid): {terc_madrid}")
    print(f"Guardia 24 h el {today}: {sum(1 for p in pharmacies if today in p['guardias'] and is24(p['guardias'][today]))} | "
          f"alguna guardia el {today}: {sum(1 for p in pharmacies if today in p['guardias'])} | "
          f"24 h en todas las fechas ({len(gdates)} días): {len(perm24)} {perm24}")
    print(f"Sin coordenadas en el registro: {no_coords}")
    if terc_not_in_cert:
        print(f"AVISO: en el PDF de terceros pero no en el de certificadas: {terc_not_in_cert}")
    no_reg = [p['soe'] for p in pharmacies if p['soe'] not in registro]
    if no_reg:
        print(f"AVISO: certificadas de Madrid sin entrada en el registro: {no_reg}")
    for a in anomalies:
        print(f"ANOMALÍA: {a}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except BuildError as e:
        log(f"ERROR: {e}")
        sys.exit(1)
