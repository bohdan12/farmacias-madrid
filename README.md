# Farmacias formuladoras de guardia · Madrid capital

Web estática que muestra, ordenadas por cercanía, las farmacias de Madrid capital certificadas para elaborar fórmulas magistrales que están abiertas ahora por guardia o servicio 24 h.

- `site/`: la web (HTML/CSS/JS, sin build). Se publica en GitHub Pages con `.github/workflows/pages.yml`.
- `scripts/farmacias/`: script para regenerar `site/data/farmacias.json` cada mes:
  `python3 -I scripts/farmacias/build_data.py --out site/data/farmacias.json`

## Fuentes
- COFM: [listados de farmacias formuladoras](https://www.cofm.es/es/transparencia/listados-de-farmacias-formuladoras/).
- Comunidad de Madrid: [registro de oficinas de farmacia](https://datos.comunidad.madrid/dataset/2d682b1d-e2e8-4c6f-b902-7a3f108e2fb9) (CC BY 4.0).
- Ayuntamiento de Madrid: [farmacias de guardia](https://datos.madrid.es/dataset/214440-0-farmacias-guardia) (CC BY 4.0, fuente COFM).

Mapa: © colaboradores de OpenStreetMap. Búsqueda de direcciones: Nominatim.

Los datos pueden cambiar: llama a la farmacia antes de ir. En caso de emergencia, llama al 112.
