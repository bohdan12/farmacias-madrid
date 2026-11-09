# Datos de farmacias formuladoras de Madrid

`build_data.py` genera `site/data/farmacias.json`, el fichero que usa
el buscador de farmacias. Contiene **todas las farmacias de Madrid capital** (municipio
«Madrid»; no Las Rozas de Madrid, Rivas-Vaciamadrid, Humanes de Madrid, etc.)
**certificadas por el COFM para elaborar fórmulas magistrales y preparados oficinales**,
con:

- dirección y código postal (según el PDF del COFM);
- formas farmacéuticas certificadas (no estériles, estériles y «otros»);
- si están autorizadas para elaborar a terceros;
- coordenadas WGS84 (convertidas desde UTM ETRS89 huso 30N del registro autonómico);
- teléfono y barrio (del fichero de guardias, cuando la farmacia aparece en él);
- todas sus guardias del calendario publicado (fecha → horario).

Se incluyen también las farmacias sin guardias (`"guardias": {}`) y las que no tienen
coordenadas en el registro (`lat`/`lng` a `null`; el script las lista al terminar).
No se publica el nombre de los titulares.

## Fuentes y licencias

| Dato | Fuente | Licencia |
|------|--------|----------|
| Farmacias certificadas para fórmulas magistrales (PDF) | Colegio Oficial de Farmacéuticos de Madrid (COFM), [Listados de farmacias formuladoras](https://www.cofm.es/es/transparencia/listados-de-farmacias-formuladoras/) | Información pública del portal de transparencia del COFM (sin licencia abierta explícita; se cita la fuente) |
| Farmacias autorizadas a terceros (PDF) | Misma página del COFM | Ídem |
| Registro de oficinas de farmacia (SOE, municipio, coordenadas UTM) | [Comunidad de Madrid, datos abiertos](https://datos.comunidad.madrid/dataset/2d682b1d-e2e8-4c6f-b902-7a3f108e2fb9) | CC BY 4.0 |
| Farmacias de guardia | [Ayuntamiento de Madrid, datos.madrid.es](https://datos.madrid.es/dataset/214440-0-farmacias-guardia) (fuente original: COFM) | CC BY 4.0 |

Las farmacias se enlazan por número SOE: la entrada `OF-00002` del PDF corresponde a
`FARMACIA_NRO_SOE = 2` del registro y a `Farmacia = 2` del fichero de guardias.

## Requisitos

- Python 3 (solo biblioteca estándar).
- `curl`.
- `pdftotext` (paquete `poppler-utils`).

## Uso

Desde la raíz del repositorio:

```sh
python3 -I scripts/farmacias/build_data.py
```

Opciones:

- `--cache-dir DIR`: dónde guardar las descargas (por defecto, un directorio temporal
  del sistema, nunca `public/`).
- `--use-cache`: reutilizar las descargas ya presentes en `--cache-dir`.
- `--out FICHERO`: ruta de salida (por defecto `site/data/farmacias.json`).
- `--today AAAA-MM-DD`: fecha usada en el resumen (guardias de ese día).

El script:

1. Lee la página del COFM y extrae los enlaces actuales a los dos PDF (cambian cada
   mes). Si no los encuentra, usa los de octubre de 2026 y lo avisa.
2. Descarga los PDF y los dos CSV con un User-Agent identificativo
   (`farmacias-madrid-build/1.0`).
3. Convierte los PDF con `pdftotext -layout` y comprueba que el número de entradas
   coincide con la cabecera «Número de oficinas de farmacia … = N». Si no coincide,
   termina con error.
4. Interpreta los horarios de guardia a partir del texto de `Duración`
   (p. ej. `SERVICIO 24 HORAS (09:30-09:30 H DÍA SIGUIENTE)` →
   `{"start":"09:30","end":"09:30","nextDay":true}`); si aparece un formato que no
   sabe interpretar, termina con error.
5. Escribe el JSON compacto y muestra un resumen (totales, farmacias sin coordenadas,
   anomalías como coordenadas fuera de Madrid, que se anulan).

## Actualización mensual

El COFM publica los listados de formuladoras cada mes y el Ayuntamiento amplía el
calendario de guardias. Cada mes:

1. Ejecutar `python3 -I scripts/farmacias/build_data.py`.
2. Revisar el resumen: total del PDF, farmacias de Madrid, sin coordenadas y anomalías.
3. Comprobar en `sources` del JSON la fecha `updated` del PDF y el rango de guardias
   (`from`/`to`).
4. Revisar el diff de `site/data/farmacias.json` y hacer commit.

## Formato de salida (resumen)

```json
{
  "generated": "2026-11-09T10:00:00Z",
  "sources": { "formulacion": {…}, "formulacionTerceros": {…}, "registro": {…}, "guardias": {…} },
  "pharmacies": [
    {
      "soe": 2, "address": "Plaza Del Dos De Mayo, 6", "cp": "28004",
      "lat": 40.427324, "lng": -3.704185, "phone": null, "barrio": null,
      "formas": { "noEsteriles": ["Cápsulas", "…"], "otrosNoEsteriles": "",
                  "esteriles": [], "otrosEsteriles": "" },
      "terceros": false,
      "guardias": { "2026-11-09": { "start": "09:30", "end": "09:30", "nextDay": true,
                                     "label": "SERVICIO 24 HORAS (09:30-09:30 H DÍA SIGUIENTE)" } }
    }
  ]
}
```

## Notas

- La conversión UTM → WGS84 usa la serie de Krüger sobre el elipsoide GRS80
  (ETRS89 ≈ WGS84 a escala de mapa). Se validó contra coordenadas de referencia del
  COFM: error mediano ≈ 0,4 m en Madrid capital.
- El fichero de guardias solo incluye las farmacias que hacen guardias, por lo que la
  mayoría de las formuladoras no tienen teléfono ni barrio en la salida.
