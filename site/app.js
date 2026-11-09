/* Farmacias de guardia con fórmulas magistrales · Madrid capital
 * Sitio estático sin dependencias salvo Leaflet. Todo dato externo se inserta
 * en el DOM con textContent / createElement (nunca innerHTML).
 */
(function () {
  'use strict';

  var CFG = {
    dataUrl: 'data/farmacias.json',
    liveCsvUrl: 'https://datos.madrid.es/dataset/214440-0-farmacias-guardia/resource/214440-3-farmacias-guardia-csv/download/214440-0-farmacias-guardia-xlsx.csv',
    liveTimeoutMs: 15000,
    nominatimUrl: 'https://nominatim.openstreetmap.org/search',
    // Madrid capital: oeste, norte, este, sur
    bbox: { west: -3.89, north: 40.65, east: -3.52, south: 40.31 },
    center: [40.4168, -3.7038],
    tz: 'Europe/Madrid'
  };

  var state = {
    data: null,
    pharmacies: [],
    user: null,            // {lat, lng, label}
    mode: 'now',           // 'now' | 'today'
    only24: false,
    onlySterile: false,
    live: null,            // {from, to, rows} si se cargaron las guardias en directo
    liveState: 'idle',     // idle | loading | ok | error
    liveCsvText: null,
    picking: false,
    lastMinuteKey: ''
  };

  var $ = function (id) { return document.getElementById(id); };

  // ---------------------------------------------------------------- utilidades DOM
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === 'text') node.textContent = v;
        else if (k === 'className') node.className = v;
        else node.setAttribute(k, v === true ? '' : String(v));
      });
    }
    (children || []).forEach(function (c) {
      if (c == null || c === false) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function safeUrl(u) {
    if (typeof u !== 'string' || !u) return null;
    try {
      var url = new URL(u, location.href);
      return (url.protocol === 'https:' || url.protocol === 'http:') ? url.href : null;
    } catch (e) { return null; }
  }

  // ---------------------------------------------------------------- tiempo (Europe/Madrid)
  var madridFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: CFG.tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });

  /** Fecha y minutos del día actuales en Madrid, independientemente de la zona del dispositivo. */
  function madridNow() {
    var p = {};
    madridFmt.formatToParts(new Date()).forEach(function (x) { p[x.type] = x.value; });
    var h = parseInt(p.hour, 10) % 24;
    return { date: p.year + '-' + p.month + '-' + p.day, minutes: h * 60 + parseInt(p.minute, 10) };
  }

  function dayNum(dateStr) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
    if (!m) return NaN;
    return Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 864e5);
  }
  function dateFromNum(n) {
    return new Date(n * 864e5).toISOString().slice(0, 10);
  }
  function hhmm(s) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
    return m ? (+m[1]) * 60 + (+m[2]) : NaN;
  }

  var dateFmtShort = new Intl.DateTimeFormat('es-ES', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
  var dateFmtLong = new Intl.DateTimeFormat('es-ES', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
  function fmtDate(dateStr, long) {
    var n = dayNum(dateStr);
    if (isNaN(n)) return String(dateStr || '');
    return (long ? dateFmtLong : dateFmtShort).format(new Date(n * 864e5));
  }
  function fmtIso(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return String(iso);
    return new Intl.DateTimeFormat('es-ES', { timeZone: CFG.tz, day: 'numeric', month: 'short', year: 'numeric' }).format(d);
  }
  function fmtAnyDate(s) {
    if (!s) return '';
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? fmtDate(s) : fmtIso(s);
  }

  /** Normaliza una guardia: minutos de inicio/fin y si termina al día siguiente. */
  function normGuardia(g) {
    if (!g) return null;
    var s = hhmm(g.start), e = hhmm(g.end);
    if (isNaN(s) || isNaN(e)) return null;
    var next = typeof g.nextDay === 'boolean' ? g.nextDay : e <= s;
    return {
      start: g.start, end: g.end, s: s, e: e, nextDay: next,
      label: g.label || ('SERVICIO (' + g.start + '-' + g.end + ' H)'),
      is24: /24\s*HORAS/i.test(g.label || '') || (next && s === e)
    };
  }

  /** ¿Está activa ahora la guardia fechada en `date`? Intervalo [D S, D(+1) E). */
  function isActive(date, g, now) {
    var d = dayNum(date);
    var start = d * 1440 + g.s;
    var end = (d + (g.nextDay ? 1 : 0)) * 1440 + g.e;
    var t = dayNum(now.date) * 1440 + now.minutes;
    return t >= start && t < end;
  }

  // ---------------------------------------------------------------- geografía
  function haversineKm(a, b) {
    var R = 6371.0088, rad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function inMadrid(lat, lng) {
    var b = CFG.bbox;
    return lat >= b.south && lat <= b.north && lng >= b.west && lng <= b.east;
  }
  function hasCoords(p) { return typeof p.lat === 'number' && typeof p.lng === 'number' && isFinite(p.lat) && isFinite(p.lng); }
  function fmtDist(km) {
    if (km < 1) return (Math.max(10, Math.round(km * 100) * 10)) + ' m';
    return km.toLocaleString('es-ES', { minimumFractionDigits: km < 10 ? 1 : 0, maximumFractionDigits: km < 10 ? 1 : 0 }) + ' km';
  }
  function fmtPhone(digits) {
    return digits.length === 9 ? digits.replace(/(\d{3})(\d{3})(\d{3})/, '$1 $2 $3') : digits;
  }

  // ---------------------------------------------------------------- mapa
  var map = null, userMarker = null, pharmLayer = null, markersBySoe = {};

  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  function initMap() {
    var mapEl = $('map');
    if (!window.L) {
      mapEl.appendChild(el('p', { className: 'map-fallback', text: 'No se ha podido cargar el mapa. Puedes seguir usando la lista de resultados.' }));
      $('btn-pick').disabled = true;
      return;
    }
    map = L.map(mapEl, { zoomControl: true, scrollWheelZoom: true }).setView(CFG.center, 12);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
    map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
    pharmLayer = L.layerGroup().addTo(map);
    map.on('click', function (ev) {
      if (!state.picking) return;
      setPicking(false);
      setUser(ev.latlng.lat, ev.latlng.lng, 'Punto elegido en el mapa');
    });
  }

  function setPicking(on) {
    state.picking = on;
    var btn = $('btn-pick');
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.textContent = on ? 'Cancelar selección en el mapa' : 'Elegir un punto en el mapa';
    $('map-hint').hidden = !on;
    if (map) map.getContainer().classList.toggle('picking', on);
    if (on && map) map.getContainer().scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (on) setLocStatus('Haz clic o toca en el mapa para fijar tu ubicación (Esc para cancelar).');
  }

  function updateUserMarker() {
    if (!map) return;
    if (userMarker) { map.removeLayer(userMarker); userMarker = null; }
    if (!state.user) return;
    userMarker = L.marker([state.user.lat, state.user.lng], {
      icon: L.divIcon({ className: '', html: '<div class="user-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
      title: 'Tu ubicación', alt: 'Tu ubicación', zIndexOffset: 1000, keyboard: false
    }).addTo(map);
  }

  function popupContent(item) {
    var p = item.p;
    var box = el('div', null, [
      el('strong', { text: p.address || 'Farmacia' }),
      el('br'),
      document.createTextNode([p.cp, p.barrio].filter(Boolean).join(' · ')),
      el('br'),
      el('span', { text: item.active ? 'Abierta ahora · ' + item.active.g.label : (item.today ? item.today.label : '') })
    ]);
    var link = el('a', { href: '#card-' + p.soe, text: 'Ver en la lista' });
    link.addEventListener('click', function (e) {
      e.preventDefault();
      var card = document.getElementById('card-' + p.soe);
      if (card) { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); card.focus({ preventScroll: true }); }
    });
    box.appendChild(el('br'));
    box.appendChild(link);
    return box;
  }

  function updatePharmMarkers(items, fit) {
    if (!map) return;
    pharmLayer.clearLayers();
    markersBySoe = {};
    var pts = [];
    items.forEach(function (item, i) {
      var p = item.p;
      if (!hasCoords(p)) return;
      var n = String(i + 1);
      var m = L.marker([p.lat, p.lng], {
        icon: L.divIcon({
          className: '',
          html: '<div class="pin' + (item.active ? ' open' : '') + '"><span>' + n + '</span></div>',
          iconSize: [26, 26], iconAnchor: [13, 26], popupAnchor: [0, -24]
        }),
        title: n + '. ' + (p.address || ''),
        alt: n + '. ' + (p.address || ''),
        riseOnHover: true
      });
      m.bindPopup(popupContent(item));
      m.addTo(pharmLayer);
      markersBySoe[p.soe] = m;
      pts.push([p.lat, p.lng]);
    });
    if (!fit) return;
    if (state.user) {
      var near = pts.slice(0, 5);
      near.push([state.user.lat, state.user.lng]);
      if (near.length > 1) map.fitBounds(near, { padding: [30, 30], maxZoom: 16 });
      else map.setView([state.user.lat, state.user.lng], 14);
    } else if (pts.length) {
      map.fitBounds(pts, { padding: [30, 30], maxZoom: 15 });
    }
  }

  // ---------------------------------------------------------------- ubicación
  function setLocStatus(msg, kind) {
    var s = $('loc-status');
    s.textContent = msg || '';
    s.className = 'status' + (kind ? ' is-' + kind : '');
  }

  function setUser(lat, lng, label) {
    state.user = { lat: lat, lng: lng, label: label };
    if (inMadrid(lat, lng)) {
      setLocStatus('Ubicación: ' + label + '.', 'ok');
    } else {
      setLocStatus('Ubicación: ' + label + '. Atención: este punto está fuera de Madrid capital y este servicio solo cubre farmacias del municipio de Madrid.', 'warn');
    }
    updateUserMarker();
    render(true);
  }

  function useGeolocation() {
    if (!('geolocation' in navigator)) {
      setLocStatus('Tu navegador no permite obtener la ubicación. Escribe una dirección o elige un punto en el mapa.', 'warn');
      return;
    }
    var btn = $('btn-geo');
    btn.disabled = true;
    setLocStatus('Obteniendo tu ubicación…');
    navigator.geolocation.getCurrentPosition(function (pos) {
      btn.disabled = false;
      setUser(pos.coords.latitude, pos.coords.longitude, 'tu ubicación actual (precisión aprox. ' + Math.round(pos.coords.accuracy || 0) + ' m)');
    }, function (err) {
      btn.disabled = false;
      var msg = err && err.code === 1
        ? 'No has dado permiso para usar tu ubicación. Puedes escribir una dirección o elegir un punto en el mapa.'
        : err && err.code === 3
          ? 'No se pudo obtener tu ubicación a tiempo. Inténtalo de nuevo, escribe una dirección o elige un punto en el mapa.'
          : 'No se pudo obtener tu ubicación. Escribe una dirección o elige un punto en el mapa.';
      setLocStatus(msg, 'warn');
    }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 });
  }

  var lastNominatim = 0;
  function geocode(q) {
    var wait = Math.max(0, lastNominatim + 1100 - Date.now());
    return new Promise(function (r) { setTimeout(r, wait); }).then(function () {
      lastNominatim = Date.now();
      var b = CFG.bbox;
      var url = CFG.nominatimUrl + '?format=json&q=' + encodeURIComponent(q) +
        '&viewbox=' + [b.west, b.north, b.east, b.south].join(',') + '&bounded=1&countrycodes=es&limit=5&accept-language=es';
      return fetch(url, { headers: { 'Accept': 'application/json' } });
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  function onAddressSubmit(ev) {
    ev.preventDefault();
    var input = $('addr');
    var q = input.value.trim();
    var list = $('addr-results');
    clear(list); list.hidden = true;
    if (q.length < 3) { setLocStatus('Escribe una dirección algo más completa.', 'warn'); input.focus(); return; }
    var btn = $('btn-addr');
    btn.disabled = true;
    setLocStatus('Buscando la dirección…');
    if (!/madrid/i.test(q)) q += ', Madrid';
    geocode(q).then(function (results) {
      btn.disabled = false;
      results = (Array.isArray(results) ? results : []).map(function (r) {
        return { lat: parseFloat(r.lat), lng: parseFloat(r.lon), name: String(r.display_name || '') };
      }).filter(function (r) { return isFinite(r.lat) && isFinite(r.lng); });
      if (!results.length) {
        setLocStatus('No se ha encontrado esa dirección dentro de Madrid capital. Prueba con otra forma de escribirla o elige un punto en el mapa.', 'warn');
        return;
      }
      if (results.length === 1) { setUser(results[0].lat, results[0].lng, results[0].name); return; }
      setLocStatus('Elige la dirección correcta:');
      results.forEach(function (r) {
        var b = el('button', { type: 'button', text: r.name });
        b.addEventListener('click', function () {
          clear(list); list.hidden = true;
          setUser(r.lat, r.lng, r.name);
        });
        list.appendChild(el('li', null, [b]));
      });
      list.hidden = false;
      list.querySelector('button').focus();
    }).catch(function () {
      btn.disabled = false;
      setLocStatus('No se pudo contactar con el buscador de direcciones. Inténtalo más tarde o elige un punto en el mapa.', 'warn');
    });
  }

  // ---------------------------------------------------------------- datos
  function loadData() {
    return fetch(CFG.dataUrl, { cache: 'no-cache' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      if (!data || !Array.isArray(data.pharmacies)) throw new Error('Formato no válido');
      state.data = data;
      state.pharmacies = data.pharmacies.filter(function (p) { return p && p.soe != null; }).map(function (p) {
        var lat = p.lat == null ? null : Number(p.lat), lng = p.lng == null ? null : Number(p.lng);
        return {
          soe: String(p.soe),
          address: p.address ? String(p.address) : '',
          cp: p.cp ? String(p.cp) : '',
          lat: isFinite(lat) && lat !== null ? lat : null,
          lng: isFinite(lng) && lng !== null ? lng : null,
          phone: p.phone ? String(p.phone).replace(/\D/g, '') : '',
          barrio: p.barrio ? String(p.barrio) : '',
          formas: p.formas || {},
          terceros: !!p.terceros,
          embeddedGuardias: p.guardias || {},
          guardias: normGuardias(p.guardias || {})
        };
      });
    });
  }

  function normGuardias(obj) {
    var out = {};
    Object.keys(obj).forEach(function (d) {
      var g = normGuardia(obj[d]);
      if (g && !isNaN(dayNum(d))) out[d] = g;
    });
    return out;
  }

  function embeddedRange() {
    var g = (state.data && state.data.sources && state.data.sources.guardias) || {};
    var from = g.from, to = g.to;
    if (!from || !to) {
      var all = [];
      state.pharmacies.forEach(function (p) { all = all.concat(Object.keys(p.guardias)); });
      all.sort();
      from = from || all[0];
      to = to || all[all.length - 1];
    }
    return { from: from || null, to: to || null };
  }

  function currentRange() { return state.live ? { from: state.live.from, to: state.live.to } : embeddedRange(); }

  function fetchLiveCsv() {
    state.liveState = 'loading';
    var ctrl = 'AbortController' in window ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, CFG.liveTimeoutMs);
    return fetch(CFG.liveCsvUrl, { signal: ctrl ? ctrl.signal : undefined, cache: 'no-store', credentials: 'omit' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .then(function (text) { clearTimeout(timer); return text; },
        function (err) { clearTimeout(timer); throw err; });
  }

  function normHeader(s) {
    return String(s).replace(/^﻿/, '').trim().toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '');
  }

  /** Parsea el CSV de guardias del Ayuntamiento. Devuelve {bySoe, from, to, rows} o lanza error. */
  function parseGuardiasCsv(text) {
    text = text.replace(/^﻿/, '');
    var lines = text.split(/\r?\n/);
    var header = lines[0].split(';').map(normHeader);
    var iFecha = header.indexOf('fecha'), iFarm = header.indexOf('farmacia'), iDur = header.indexOf('duracion');
    if (iFecha < 0 || iFarm < 0 || iDur < 0) throw new Error('Cabecera inesperada');
    var reTime = /(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/;
    var bySoe = {}, from = null, to = null, rows = 0;
    for (var i = 1; i < lines.length; i++) {
      var line = lines[i];
      if (!line) continue;
      var c = line.split(';').map(function (x) { return x.trim().replace(/^"(.*)"$/, '$1'); });
      var dm = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(c[iFecha] || '');
      var tm = reTime.exec(c[iDur] || '');
      var soe = (c[iFarm] || '').replace(/^0+(?=\d)/, '');
      if (!dm || !tm || !/^\d+$/.test(soe)) continue;
      var date = dm[3] + '-' + ('0' + dm[2]).slice(-2) + '-' + ('0' + dm[1]).slice(-2);
      var start = ('0' + tm[1]).slice(-2) + ':' + tm[2], end = ('0' + tm[3]).slice(-2) + ':' + tm[4];
      var g = normGuardia({ start: start, end: end, nextDay: hhmm(end) <= hhmm(start), label: c[iDur] });
      if (!g) continue;
      rows++;
      if (!from || date < from) from = date;
      if (!to || date > to) to = date;
      var m = bySoe[soe] || (bySoe[soe] = {});
      var prev = m[date];
      // Si hubiera dos entradas el mismo día, nos quedamos con la más larga.
      if (!prev || duration(g) > duration(prev)) m[date] = g;
    }
    if (rows < 50) throw new Error('Demasiadas pocas filas');
    return { bySoe: bySoe, from: from, to: to, rows: rows };
  }
  function duration(g) { return (g.nextDay ? 1440 : 0) + g.e - g.s; }

  function applyLive(parsed) {
    state.pharmacies.forEach(function (p) { p.guardias = parsed.bySoe[p.soe] || {}; });
    state.live = { from: parsed.from, to: parsed.to, rows: parsed.rows };
  }

  // ---------------------------------------------------------------- lógica de resultados
  function evaluate(p, now) {
    var today = now.date, yesterday = dateFromNum(dayNum(now.date) - 1);
    var gT = p.guardias[today] || null, gY = p.guardias[yesterday] || null;
    var active = null;
    if (gY && isActive(yesterday, gY, now)) active = { date: yesterday, g: gY, fromYesterday: true };
    if (gT && isActive(today, gT, now)) active = { date: today, g: gT, fromYesterday: false };
    return { p: p, today: gT, yesterday: gY, active: active };
  }

  function hasSterile(p) {
    var f = p.formas || {};
    return (Array.isArray(f.esteriles) && f.esteriles.length > 0) || (typeof f.otrosEsteriles === 'string' && f.otrosEsteriles.trim() !== '');
  }

  function computeItems(now) {
    var items = [];
    state.pharmacies.forEach(function (p) {
      var it = evaluate(p, now);
      var relevant;
      if (state.mode === 'now') {
        if (!it.active) return;
        relevant = [it.active.g];
      } else {
        if (!it.today && !it.active) return;
        relevant = [it.today, it.active && it.active.g].filter(Boolean);
      }
      if (state.only24 && !relevant.some(function (g) { return g.is24; })) return;
      if (state.onlySterile && !hasSterile(p)) return;
      it.dist = state.user && hasCoords(p) ? haversineKm(state.user, p) : null;
      items.push(it);
    });
    items.sort(function (a, b) {
      if (state.user) {
        if (a.dist == null && b.dist != null) return 1;
        if (b.dist == null && a.dist != null) return -1;
        if (a.dist != null && b.dist != null && a.dist !== b.dist) return a.dist - b.dist;
      }
      if (!!a.active !== !!b.active) return a.active ? -1 : 1;
      return (a.p.barrio + a.p.address).localeCompare(b.p.barrio + b.p.address, 'es');
    });
    return items;
  }

  // ---------------------------------------------------------------- render
  function formsDetails(p) {
    var f = p.formas || {};
    var groups = [
      ['No estériles', f.noEsteriles, f.otrosNoEsteriles],
      ['Estériles', f.esteriles, f.otrosEsteriles]
    ];
    var total = 0;
    var body = el('div');
    groups.forEach(function (g) {
      var list = (Array.isArray(g[1]) ? g[1] : []).map(String).filter(Boolean);
      var otros = typeof g[2] === 'string' ? g[2].trim() : '';
      if (!list.length && !otros) return;
      total += list.length + (otros ? 1 : 0);
      body.appendChild(el('h4', { text: g[0] }));
      var ul = el('ul');
      list.forEach(function (x) { ul.appendChild(el('li', { text: x })); });
      if (otros) ul.appendChild(el('li', { text: 'Otras: ' + otros }));
      body.appendChild(ul);
    });
    if (!total) return el('p', { className: 'meta', text: 'Formas farmacéuticas: sin detalle en el listado.' });
    return el('details', { className: 'forms' }, [
      el('summary', { text: 'Formas farmacéuticas certificadas (' + total + ')' }),
      body
    ]);
  }

  function scheduleLines(it, now) {
    var lines = [];
    if (it.active && it.active.fromYesterday) {
      lines.push(el('p', { className: 'schedule' }, [
        el('strong', { text: 'Guardia iniciada ayer (' + fmtDate(it.active.date) + '): ' }),
        it.active.g.label
      ]));
    }
    if (it.today) {
      lines.push(el('p', { className: 'schedule' }, [el('strong', { text: 'Guardia hoy: ' }), it.today.label]));
    }
    return lines;
  }

  function card(it, idx, now) {
    var p = it.p;
    var open = !!it.active;
    var is24 = (it.active && it.active.g.is24) || (it.today && it.today.is24);
    var title = el('button', { type: 'button', text: (idx + 1) + '. ' + (p.address || 'Farmacia sin dirección'), 'aria-label': 'Ver en el mapa: ' + (p.address || '') });
    title.addEventListener('click', function () {
      var m = markersBySoe[p.soe];
      if (m && map) { map.setView(m.getLatLng(), Math.max(map.getZoom(), 15)); m.openPopup(); $('map').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
    });
    var titleNode = hasCoords(p) && map ? title : document.createTextNode((idx + 1) + '. ' + (p.address || 'Farmacia sin dirección'));

    var distNode = it.dist != null
      ? el('div', { className: 'dist' }, [fmtDist(it.dist), el('small', { text: 'en línea recta' })])
      : (state.user && !hasCoords(p) ? el('div', { className: 'dist' }, [el('small', { text: 'sin coordenadas' })]) : null);

    var badges = el('div', { className: 'badges' }, [
      open ? el('span', { className: 'badge badge-open', text: '● Abierta ahora' }) : el('span', { className: 'badge badge-closed', text: 'No abierta en este momento' }),
      is24 ? el('span', { className: 'badge badge-24', text: '24 horas' }) : null,
      p.terceros ? el('span', { className: 'badge', text: 'Elabora para terceros' }) : null,
      hasSterile(p) ? el('span', { className: 'badge', text: 'Estériles' }) : null
    ]);

    var actions = el('div', { className: 'actions' });
    if (p.phone) actions.appendChild(el('a', { href: 'tel:+34' + p.phone, text: '☎ ' + fmtPhone(p.phone), 'aria-label': 'Llamar al ' + fmtPhone(p.phone) }));
    var dest = hasCoords(p) ? p.lat + ',' + p.lng : [p.address, p.cp, 'Madrid'].filter(Boolean).join(', ');
    actions.appendChild(el('a', {
      href: 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(dest),
      target: '_blank', rel: 'noopener noreferrer', text: 'Cómo llegar ↗',
      'aria-label': 'Cómo llegar a ' + (p.address || 'la farmacia') + ' (abre Google Maps en otra pestaña)'
    }));

    var meta = [p.cp ? 'CP ' + p.cp : '', p.barrio ? p.barrio : ''].filter(Boolean).join(' · ');

    var li = el('li', { className: 'card' + (open ? ' is-open' : ''), id: 'card-' + p.soe, tabindex: '-1' }, [
      el('div', { className: 'card-top' }, [el('div', null, [el('h3', null, [titleNode]), meta ? el('p', { className: 'meta', text: meta }) : null]), distNode]),
      badges
    ].concat(scheduleLines(it, now)).concat([actions, formsDetails(p)]));
    return li;
  }

  function render(fitMap) {
    if (!state.data) return;
    var now = madridNow();
    state.lastMinuteKey = now.date + ' ' + now.minutes;
    var hh = ('0' + Math.floor(now.minutes / 60)).slice(-2), mm = ('0' + now.minutes % 60).slice(-2);
    $('clock').textContent = 'Hora en Madrid: ' + fmtDate(now.date, true) + ', ' + hh + ':' + mm;

    // Aviso de rango de fechas
    var range = currentRange();
    var warn = $('range-warning');
    if (range.from && range.to && (now.date < range.from || now.date > range.to)) {
      warn.textContent = 'Atención: hoy (' + fmtDate(now.date) + ') está fuera del periodo cubierto por los datos de guardias (' +
        fmtDate(range.from) + ' – ' + fmtDate(range.to) + '). Los resultados pueden estar incompletos o no ser válidos.';
      warn.hidden = false;
    } else if (!range.from) {
      warn.textContent = 'Atención: no hay datos de guardias disponibles.';
      warn.hidden = false;
    } else {
      warn.hidden = true;
    }

    var items = computeItems(now);
    var list = $('list');
    clear(list);
    items.forEach(function (it, i) { list.appendChild(card(it, i, now)); });

    var nOpen = items.filter(function (it) { return it.active; }).length;
    var summary;
    if (state.mode === 'now') {
      summary = items.length === 1 ? '1 farmacia abierta ahora' : items.length + ' farmacias abiertas ahora';
    } else {
      summary = (items.length === 1 ? '1 farmacia con guardia hoy' : items.length + ' farmacias con guardia hoy') +
        ' (' + nOpen + ' abierta' + (nOpen === 1 ? '' : 's') + ' ahora)';
    }
    summary += state.user ? ', ordenadas por distancia en línea recta desde tu ubicación.' : '. Indica tu ubicación para ordenarlas por cercanía.';
    $('summary').textContent = summary;

    if (!items.length) {
      var msg = state.mode === 'now'
        ? 'Ahora mismo no hay ninguna farmacia con formulación magistral de guardia que cumpla los filtros. Prueba «Con guardia hoy» o quita filtros.'
        : 'Hoy no hay ninguna farmacia con formulación magistral de guardia que cumpla los filtros.';
      list.appendChild(el('li', { className: 'empty', text: msg }));
    }

    updatePharmMarkers(items, fitMap);
  }

  function renderDataStatus() {
    var box = $('data-status');
    clear(box);
    box.className = 'notice';
    if (state.liveState === 'loading') {
      box.appendChild(el('span', { className: 'spinner', 'aria-hidden': 'true' }));
      box.appendChild(document.createTextNode('Comprobando guardias actualizadas en datos.madrid.es… Mientras tanto se muestran los datos incluidos.'));
      return;
    }
    if (state.live) {
      box.className = 'notice is-live';
      box.appendChild(document.createTextNode('Guardias actualizadas en directo desde datos.madrid.es (periodo ' +
        fmtDate(state.live.from) + ' – ' + fmtDate(state.live.to) + ').'));
      return;
    }
    var r = embeddedRange();
    box.appendChild(document.createTextNode(
      (state.liveState === 'error' ? 'No se pudo actualizar en directo; ' : '') +
      'se usan los datos de guardias incluidos' +
      (r.from ? ' (periodo ' + fmtDate(r.from) + ' – ' + fmtDate(r.to) + ')' : '') + '.'));
  }

  function renderSources() {
    var ul = $('sources');
    clear(ul);
    var src = (state.data && state.data.sources) || {};
    var defs = [
      ['formulacion', 'Farmacias certificadas para elaborar fórmulas magistrales'],
      ['formulacionTerceros', 'Farmacias que elaboran fórmulas para terceros'],
      ['registro', 'Registro de farmacias (direcciones, teléfonos y coordenadas)'],
      ['guardias', 'Calendario de farmacias de guardia (datos incluidos)']
    ];
    Object.keys(src).forEach(function (k) {
      if (!defs.some(function (d) { return d[0] === k; })) defs.push([k, k]);
    });
    defs.forEach(function (d) {
      var s = src[d[0]];
      if (!s || typeof s !== 'object') return;
      var li = el('li');
      var href = safeUrl(s.url);
      li.appendChild(href ? el('a', { href: href, rel: 'noopener noreferrer', text: d[1] }) : el('span', { text: d[1] }));
      var bits = [];
      if (s.publisher) bits.push(String(s.publisher));
      if (s.license) bits.push('Licencia: ' + s.license);
      if (s.from && s.to) bits.push('Periodo: ' + fmtDate(s.from) + ' – ' + fmtDate(s.to));
      if (s.updated) bits.push('Actualizado: ' + fmtAnyDate(String(s.updated)));
      if (bits.length) li.appendChild(document.createTextNode('. ' + bits.join(' · ') + '.'));
      var page = safeUrl(s.page);
      if (page && page !== href) {
        li.appendChild(document.createTextNode(' '));
        li.appendChild(el('a', { href: page, rel: 'noopener noreferrer', text: '(página de origen)' }));
      }
      ul.appendChild(li);
    });
    if (state.live) {
      ul.appendChild(el('li', null, [
        el('a', { href: 'https://datos.madrid.es/dataset/214440-0-farmacias-guardia', rel: 'noopener noreferrer', text: 'Farmacias de guardia (en directo)' }),
        document.createTextNode('. Ayuntamiento de Madrid, Portal de Datos Abiertos · Licencia: CC BY 4.0 · Consultado hoy (' +
          fmtDate(state.live.from) + ' – ' + fmtDate(state.live.to) + ').')
      ]));
    }
    $('generated').textContent = state.data && state.data.generated ? 'Datos compilados el ' + fmtIso(state.data.generated) + '.' : '';
  }

  // ---------------------------------------------------------------- arranque
  function bindUi() {
    $('btn-geo').addEventListener('click', useGeolocation);
    $('btn-pick').addEventListener('click', function () { setPicking(!state.picking); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && state.picking) { setPicking(false); setLocStatus(''); } });
    $('addr-form').addEventListener('submit', onAddressSubmit);
    Array.prototype.forEach.call(document.querySelectorAll('input[name="mode"]'), function (r) {
      r.addEventListener('change', function () { if (r.checked) { state.mode = r.value; render(true); } });
    });
    $('f-24h').addEventListener('change', function (e) { state.only24 = e.target.checked; render(true); });
    $('f-ster').addEventListener('change', function (e) { state.onlySterile = e.target.checked; render(true); });
    // Recalcula «abierta ahora» cuando cambia el minuto.
    setInterval(function () {
      var n = madridNow();
      if (n.date + ' ' + n.minutes !== state.lastMinuteKey) render(false);
    }, 20000);
  }

  function start() {
    bindUi();
    initMap();
    var livePromise = fetchLiveCsv().then(function (t) { return t; }, function () { return null; });
    state.liveState = 'loading';
    loadData().then(function () {
      renderDataStatus();
      renderSources();
      render(true);
      return livePromise.then(function (text) {
        var parsed = null;
        if (text) { try { parsed = parseGuardiasCsv(text); } catch (e) { parsed = null; } }
        if (parsed) { applyLive(parsed); state.liveState = 'ok'; } else { state.liveState = 'error'; }
        renderDataStatus();
        renderSources();
        render(false);
      });
    }).catch(function () {
      var box = $('data-status');
      box.className = 'notice notice-warn';
      box.textContent = 'No se han podido cargar los datos de farmacias. Recarga la página o inténtalo más tarde.';
      $('summary').textContent = '';
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
