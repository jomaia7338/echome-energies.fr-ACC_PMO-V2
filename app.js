// ========= Helpers =========
const $ = (id) => document.getElementById(id);
const setStatus = (m) => { const el = $('status'); if (el) el.textContent = m; };
const showError = (m) => {
  const box = $('error-box'); if (!box) return;
  box.classList.remove('hidden');
  box.textContent += `[${new Date().toLocaleTimeString()}] ${m}\n`;
  console.error(m);
};
const copyToClipboard = async (text) => {
  try { await navigator.clipboard.writeText(text); setStatus('Lien copié'); }
  catch { showError('Impossible de copier le lien'); }
};

// ========= Réseaux externes =========
async function fetchJSON(url, { method='GET', body, headers={}, timeoutMs=15000, retries=1, expect='auto' } = {}){
  const ctrl = new AbortController(); const t = setTimeout(()=>ctrl.abort(), timeoutMs);
  try{
    const res = await fetch(url, { method, body, headers, signal: ctrl.signal, cache:'no-store' });
    if(!res.ok){ const txt = await res.text().catch(()=> ''); throw new Error(`HTTP ${res.status} on ${url} :: ${txt.slice(0,240)}`); }
    const ct = res.headers.get('content-type') || '';
    if(expect==='text') return await res.text();
    if(expect==='json' || ct.includes('application/json')) return await res.json();
    const raw = await res.text(); try{ return JSON.parse(raw); }catch{ return raw; }
  }catch(e){
    if(retries>0){ await new Promise(r=>setTimeout(r, Math.min(2500, timeoutMs/3))); return fetchJSON(url,{method,body,headers,timeoutMs:Math.round(timeoutMs*1.5),retries:retries-1,expect}); }
    throw e;
  }finally{ clearTimeout(t); }
}
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
async function overpass(query){
  try{
    const body = new URLSearchParams({ data: query }).toString();
    return await fetchJSON(OVERPASS_URL, {
      method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8'},
      body, timeoutMs:20000, retries:2, expect:'json'
    });
  }catch(e){ showError(`Overpass KO: ${e.message}`); return null; }
}
async function getCommuneParCoord(lat, lon){
  const url = `https://geo.api.gouv.fr/communes?lat=${lat}&lon=${lon}&fields=nom,code,epci&format=json&type=commune`;
  try{
    const arr = await fetchJSON(url, { timeoutMs:10000, retries:1, expect:'json' });
    if(!Array.isArray(arr)||arr.length===0) throw new Error('Aucune commune trouvée');
    return arr[0];
  }catch(e){ showError(`Commune/EPCI KO: ${e.message}`); return null; }
}
async function geocodeAdresse(q){
  const url = `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(q)}&limit=1`;
  try{
    const json = await fetchJSON(url, { timeoutMs:10000, retries:1, expect:'json' });
    const feat = json?.features?.[0]; if(!feat) throw new Error('Adresse introuvable');
    const [lon, lat] = feat.geometry.coordinates; const label = feat.properties?.label || q;
    return { lat, lon, label };
  }catch(e){ showError(`Géocodage KO: ${e.message}`); return null; }
}

// ========= Géodésie =========
function haversineMeters(a,b){
  const R=6371000, toRad=d=>d*Math.PI/180;
  const dLat=toRad(b.lat-a.lat), dLon=toRad(b.lon-a.lon);
  const lat1=toRad(a.lat), lat2=toRad(b.lat);
  const h=Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(h));
}

// ========= État =========
const STORAGE_NS = 'echome-acc-terrain';
const STORAGE_LAST = `${STORAGE_NS}:lastProjectId`;
const projectKey = (id) => `${STORAGE_NS}:project:${id}`;
const newId = () => (crypto?.randomUUID?.() || String(Date.now()));
const prodIcon = L.divIcon({ className:'prod-icon', html:'<div class="pin"></div>', iconSize:[24,24], iconAnchor:[12,24] });

const app = {
  projectId: null, projectName:'', addrLabel:'',
  map:null,

  // Producteur & centre visuel
  producteur: null,            // {lat, lon}
  centreMode:'producer',       // 'producer' | 'free'
  placingProducer:false,
  centreLibre:{ lat:45.191, lon:5.684 },

  // Périmètre & zone
  distMaxKm:2,                 // diamètre légal
  distExplorKm:2,              // rayon visuel de prospection
  zoneRegl: 'STD',             // STD | PERI | RURAL | EPCI
  reseau:'BT',

  // Couches Leaflet
  layers:{
    producerMarker:null, freeMarker:null,
    cercleHalo:null, cercleEdge:null,
    cand:L.layerGroup(), part:L.layerGroup(), sis:L.layerGroup(), legal:L.layerGroup(),
    maxPairLine:null, maxPairLabel:null
  },

  candidats:[], participants:[]
};

// ========= Carte =========
function getCentreRayon(){ return (app.centreMode==='producer' && app.producteur) ? app.producteur : app.centreLibre; }
function setupMap(){
  app.map = L.map('map', { zoomControl:true }).setView([app.centreLibre.lat, app.centreLibre.lon], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{ attribution:'© OSM' }).addTo(app.map);

  // Confort d’usage
  app.map.scrollWheelZoom.disable();      // empêche les zooms involontaires à la molette
  app.map.touchZoom.enable();
  app.map.doubleClickZoom.enable();

  // Pane dédié au périmètre (meilleure lisibilité)
  app.map.createPane('perimeter');
  app.map.getPane('perimeter').classList.add('perimeter-pane');

  // Point libre
  app.layers.freeMarker = L.marker([app.centreLibre.lat, app.centreLibre.lon], { draggable:true, title:'Point libre' }).addTo(app.map);
  app.layers.freeMarker.on('dragend', ()=>{
    const { lat, lng } = app.layers.freeMarker.getLatLng();
    app.centreLibre = { lat, lon: lng };
    $('lat').value = lat.toFixed(6); $('lon').value = lng.toFixed(6);
    redrawCircle(); refreshAll(); saveProject();
  });

  // Click carte: place producteur si mode actif, sinon déplace le point libre
  app.map.on('click', (e)=>{
    if (app.placingProducer){
      setProducteur({ lat:e.latlng.lat, lon:e.latlng.lng });
      app.placingProducer = false; const b=$('btnPlaceProducer'); if(b) b.classList.remove('primary');
      return;
    }
    app.centreLibre = { lat:e.latlng.lat, lon:e.latlng.lng };
    app.layers.freeMarker.setLatLng([app.centreLibre.lat, app.centreLibre.lon]);
    $('lat').value = app.centreLibre.lat.toFixed(6); $('lon').value = app.centreLibre.lon.toFixed(6);
    redrawCircle(); refreshAll(); saveProject();
  });

  app.layers.cand.addTo(app.map);
  app.layers.part.addTo(app.map);
  app.layers.sis.addTo(app.map);
  app.layers.legal.addTo(app.map);
  redrawCircle();
}
function setProducteur({lat, lon}){
  app.producteur = { lat, lon };
  $('prodLat').value = lat.toFixed(6); $('prodLon').value = lon.toFixed(6);
  if(!app.layers.producerMarker){
    app.layers.producerMarker = L.marker([lat,lon], { draggable:true, title:'Producteur', icon: prodIcon }).addTo(app.map);
    app.layers.producerMarker.on('dragend', ()=>{
      const { lat, lng } = app.layers.producerMarker.getLatLng();
      app.producteur = { lat, lon: lng };
      $('prodLat').value = lat.toFixed(6); $('prodLon').value = lon.toFixed(6);
      redrawCircle(); refreshAll(); saveProject();
    });
  } else {
    app.layers.producerMarker.setLatLng([lat,lon]).addTo(app.map);
  }
  redrawCircle(); refreshAll(); saveProject();
}
function clearProducteur(){
  app.producteur = null;
  if(app.layers.producerMarker){ app.map.removeLayer(app.layers.producerMarker); app.layers.producerMarker = null; }
  redrawCircle(); refreshAll(); saveProject();
}

// Périmètre lisible (halo + tirets + remplissage discret)
function redrawCircle(){
  const c = getCentreRayon();
  const r = Math.max(1, (Number($('distExplor')?.value) || app.distExplorKm) * 1000);

  if(app.layers.cercleHalo){ app.map.removeLayer(app.layers.cercleHalo); app.layers.cercleHalo=null; }
  if(app.layers.cercleEdge){ app.map.removeLayer(app.layers.cercleEdge); app.layers.cercleEdge=null; }

  app.layers.cercleHalo = L.circle([c.lat, c.lon], {
    radius:r, pane:'perimeter',
    color:'#00ffd0', opacity:0.18, weight:12, fill:false
  }).addTo(app.map);

  app.layers.cercleEdge = L.circle([c.lat, c.lon], {
    radius:r, pane:'perimeter',
    color:'#37C3AF', weight:3, opacity:0.95, dashArray:'8,6',
    fillOpacity:.06, fillColor:'#37C3AF'
  }).addTo(app.map);
}

// ========= Participants & conformité =========
function drawParticipants(){
  app.layers.part.clearLayers();
  app.participants.forEach(p=>{
    const color = p.type==='producer' ? '#f5b841' : '#4ea2ff';
    L.circleMarker([p.lat,p.lon],{ radius:6, color, weight:2, fillOpacity:.7 })
      .bindPopup(`<b>${p.nom}</b><br>${p.type}<br>${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`)
      .addTo(app.layers.part);
  });
  $('kpiPart').textContent = app.participants.length;
  checkLegalPerimeter();
}
function addParticipant(p){ app.participants.push(p); drawParticipants(); renderParticipantsList(); saveProject(); }
function removeParticipant(id){ app.participants = app.participants.filter(x=>x.id!==id); drawParticipants(); renderParticipantsList(); saveProject(); }
function renderParticipantsList(){
  const wrap = $('listParts'); if(!wrap) return; wrap.innerHTML = '';
  app.participants.forEach(p=>{
    const div = document.createElement('div'); div.className='part';
    div.innerHTML = `<div><div><b>${p.nom}</b> — ${p.type}</div><div class="meta">${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}</div></div><div><button data-id="${p.id}" class="danger">Supprimer</button></div>`;
    div.querySelector('button').onclick = (e)=> removeParticipant(e.currentTarget.getAttribute('data-id'));
    wrap.appendChild(div);
  });
}

// Contrôle pair-à-pair + surbrillance de la pire paire
function checkLegalPerimeter(){
  app.layers.legal.clearLayers();

  if(app.layers.maxPairLine){ app.map.removeLayer(app.layers.maxPairLine); app.layers.maxPairLine=null; }
  if(app.layers.maxPairLabel){ app.map.removeLayer(app.layers.maxPairLabel); app.layers.maxPairLabel=null; }

  const pts=[]; if(app.producteur) pts.push({ ...app.producteur, label:'Producteur' });
  app.participants.forEach(p=> pts.push({ lat:p.lat, lon:p.lon, label:p.nom }));

  let ok = true, worst = { d:0, a:null, b:null };

  for(let i=0;i<pts.length;i++){
    for(let j=i+1;j<pts.length;j++){
      const dKm = haversineMeters(pts[i], pts[j])/1000;
      if(dKm > app.distMaxKm){
        ok = false;
        L.polyline([[pts[i].lat,pts[i].lon],[pts[j].lat,pts[j].lon]], { color:'#cc2b4a', weight:2, opacity:.9 })
          .addTo(app.layers.legal)
          .bindPopup(`${pts[i].label} ↔ ${pts[j].label}<br><b>${dKm.toFixed(2)} km</b> (> ${app.distMaxKm} km)`);
      }
      if(dKm > worst.d) worst = { d:dKm, a:pts[i], b:pts[j] };
    }
  }

  // Surbrillance de la pire paire
  if(worst.a && worst.b){
    app.layers.maxPairLine = L.polyline(
      [[worst.a.lat,worst.a.lon],[worst.b.lat,worst.b.lon]],
      { color: ok ? '#2ecc71' : '#e67e22', weight:4, opacity:.85 }
    ).addTo(app.map);
    const mid = { lat:(worst.a.lat+worst.b.lat)/2, lon:(worst.a.lon+worst.b.lon)/2 };
    app.layers.maxPairLabel = L.marker([mid.lat,mid.lon],{
      icon: L.divIcon({ className:'maxpair-label', html:`${worst.d.toFixed(2)} km / ≤ ${app.distMaxKm} km` })
    }).addTo(app.map);
  }

  $('kpiLegal').textContent = pts.length<2 ? '—' : (ok ? 'Conforme ✔︎' : 'Non conforme ✖︎');

  // KPI "dans le rayon visuel"
  const c = getCentreRayon(); const rKm = (Number($('distExplor')?.value) || app.distExplorKm);
  const inScan = app.participants.filter(p => (haversineMeters(c,{lat:p.lat,lon:p.lon})/1000) <= rKm).length;
  $('kpiRayon').textContent = inScan;
}

// ========= Prospection / SIS =========
function overpassQueryCandidats({ lat, lon, distKm, cats }){
  const r = Math.max(1, Math.round(distKm*1000));
  const b=[];
  if(cats.has('education')) b.push(`node(around:${r},${lat},${lon})["amenity"~"school|college|university"];`);
  if(cats.has('sante'))     b.push(`node(around:${r},${lat},${lon})["amenity"~"clinic|hospital|doctors|pharmacy"];`);
  if(cats.has('adm'))       b.push(`node(around:${r},${lat},${lon})["amenity"~"townhall|public_building|library"];`);
  if(cats.has('sport'))     b.push(`node(around:${r},${lat},${lon})["leisure"~"sports_centre|stadium|pitch|swimming_pool"];`);
  if(cats.has('commerce'))  b.push(`node(around:${r},${lat},${lon})["shop"]; node(around:${r},${lat},${lon})["amenity"="marketplace"];`);
  if(cats.has('industrie')) b.push(`node(around:${r},${lat},${lon})["industrial"];`);
  if(cats.has('parking'))   b.push(`node(around:${r},${lat},${lon})["amenity"="parking"];`);
  return `[out:json][timeout:25];( ${b.join('\n')} );out center;`;
}
function normalizeOSM(elements){
  const out=[]; (elements||[]).forEach(e=>{
    const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
    if(Number.isFinite(lat) && Number.isFinite(lon)){
      out.push({ id:`osm-${e.type}-${e.id}`, nom:e.tags?.name || e.tags?.ref || '—', lat, lon, raw:e.tags||{} });
    }
  }); return out;
}
async function scanCandidats(){
  setStatus('Scan OSM…');
  const cats = new Set([...document.querySelectorAll('.cat:checked')].map(i=>i.value));
  if(cats.size===0){ setStatus('Aucune catégorie sélectionnée'); return; }
  const c = getCentreRayon();
  const dist = Number($('distExplor')?.value) || app.distExplorKm || app.distMaxKm;
  const q = overpassQueryCandidats({ lat:c.lat, lon:c.lon, distKm:dist, cats });
  const data = await overpass(q);
  app.layers.cand.clearLayers(); app.candidats = [];
  if(data && Array.isArray(data.elements)){
    app.candidats = normalizeOSM(data.elements);
    app.candidats.forEach(x=>{
      L.circleMarker([x.lat,x.lon],{ radius:6, color:'#ff6b7a', weight:2, fillOpacity:.7 })
        .bindPopup(`<b>${x.nom}</b><br>${x.lat.toFixed(5)}, ${x.lon.toFixed(5)}`)
        .addTo(app.layers.cand);
    });
  }
  $('kpiCand').textContent = app.candidats.length; setStatus('Prêt');
}
function overpassSISQuery({ lat, lon, distKm }){
  const r = Math.max(1, Math.round(distKm*1000));
  return `[out:json][timeout:25];(node(around:${r},${lat},${lon})["emergency"="fire_hydrant"];node(around:${r},${lat},${lon})["amenity"="fire_station"];way(around:${r},${lat},${lon})["amenity"="fire_station"];relation(around:${r},${lat},${lon})["amenity"="fire_station"];);out center;`;
}
async function loadSIS(){
  setStatus('Chargement SIS…');
  const c = getCentreRayon();
  const dist = Number($('distExplor')?.value) || app.distExplorKm || app.distMaxKm;
  const q = overpassSISQuery({ lat:c.lat, lon:c.lon, distKm:dist });
  const data = await overpass(q);
  app.layers.sis.clearLayers();
  if(data && Array.isArray(data.elements)){
    normalizeOSM(data.elements).forEach(p=>{
      L.circleMarker([p.lat,p.lon],{ radius:6, color:'#ff6b7a', weight:2, fillOpacity:.7 })
        .bindPopup(`<b>SIS</b><br>${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`)
        .addTo(app.layers.sis);
    });
  }
  setStatus('Prêt');
}

// ========= Storage =========
function getCurrentProjectPayload(){
  return { __v:5, savedAt:new Date().toISOString(), state:{
    projectName: app.projectName, addrLabel: app.addrLabel, producteur: app.producteur,
    centreMode: app.centreMode, centreLibre: app.centreLibre,
    distMaxKm: app.distMaxKm, distExplorKm: app.distExplorKm, zoneRegl: app.zoneRegl, reseau: app.reseau,
    participants: app.participants
  }};
}
function saveProject(explicit=false){
  try{
    if(!app.projectId) app.projectId = newId();
    localStorage.setItem(projectKey(app.projectId), JSON.stringify(getCurrentProjectPayload()));
    localStorage.setItem(STORAGE_LAST, app.projectId);
    if (explicit) setStatus('Projet enregistré (local)');
    const url = new URL(location.href); url.searchParams.set('project', app.projectId);
    history.replaceState(null, '', url.toString());
  }catch(e){ showError(`Sauvegarde KO: ${e.message}`); }
}
function loadProjectById(id){ try{ const raw = localStorage.getItem(projectKey(id)); return raw?JSON.parse(raw):null; }catch(e){ showError('Projet corrompu'); return null; } }
function applyProjectPayload(payload){
  const s = payload?.state || {};
  app.projectName = s.projectName || ''; app.addrLabel = s.addrLabel || '';
  app.producteur = s.producteur || null; app.centreMode = s.centreMode || 'producer';
  app.centreLibre = s.centreLibre || app.centreLibre;
  app.distMaxKm = s.distMaxKm ?? 2; app.distExplorKm = s.distExplorKm ?? app.distMaxKm;
  app.zoneRegl = s.zoneRegl || 'STD';
  app.reseau = s.reseau || app.reseau; app.participants = Array.isArray(s.participants) ? s.participants : [];

  // UI fields
  $('projectName').value = app.projectName; $('addr').value = app.addrLabel;
  if(app.producteur){ setProducteur(app.producteur); } else { clearProducteur(); }
  $('prodLat').value = app.producteur ? app.producteur.lat.toFixed(6) : '';
  $('prodLon').value = app.producteur ? app.producteur.lon.toFixed(6) : '';

  $('distMaxPreset').value = [2,10,20].includes(Number(app.distMaxKm)) ? String(app.distMaxKm) : 'perso';
  if($('distMaxPreset').value==='perso') $('distMaxPerso').value = app.distMaxKm; else $('distMaxPerso').value = '';
  $('distExplor').value = app.distExplorKm;

  $('lat').value = app.centreLibre.lat.toFixed(6); $('lon').value = app.centreLibre.lon.toFixed(6);
  document.querySelectorAll('input[name="centreMode"]').forEach(r=> r.checked = (r.value === app.centreMode));
  if(app.layers.freeMarker) app.layers.freeMarker.setLatLng([app.centreLibre.lat, app.centreLibre.lon]);

  // Zone buttons state
  document.querySelectorAll('#zoneBtns .seg-btn').forEach(b=>{
    b.classList.toggle('active', b.getAttribute('data-zone') === app.zoneRegl);
  });

  renderParticipantsList(); drawParticipants(); refreshCommune(); setStatus('Projet chargé');
}
function deleteProject(){
  if(!app.projectId) return;
  try{
    localStorage.removeItem(projectKey(app.projectId));
    const last = localStorage.getItem(STORAGE_LAST);
    if(last === app.projectId) localStorage.removeItem(STORAGE_LAST);
    setStatus('Projet supprimé (local)');
  }catch{}
}
function detectStartupProjectId(){
  const p = new URLSearchParams(location.search).get('project');
  if(p) return p; try { return localStorage.getItem(STORAGE_LAST) || null; } catch { return null; }
}

// ========= UI (tabs, geo, boutons) =========
function wireTabs(){
  const buttons = document.querySelectorAll('.seg-btn[data-tab]');
  buttons.forEach(btn=>{
    btn.addEventListener('click', ()=>{
      buttons.forEach(b=>b.classList.remove('active')); btn.classList.add('active');
      document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
      const id = btn.getAttribute('data-tab'); document.getElementById(id).classList.add('active');
    });
  });
}
function wireUI(){
  wireTabs();

  // FAB mobile: ouvre/ferme le panneau + lock scroll body + close on outside click
  const fab = $('fabOptions'); const side = $('side');
  if (fab && side) {
    fab.addEventListener('click', ()=>{
      side.classList.toggle('open');
      document.body.classList.toggle('no-scroll', side.classList.contains('open'));
    });
    document.addEventListener('click', (e)=>{
      if (!side.classList.contains('open')) return;
      const clickInside = side.contains(e.target) || fab.contains(e.target);
      if (!clickInside) { side.classList.remove('open'); document.body.classList.remove('no-scroll'); }
    });
  }

  // Dossier
  const projectNameEl = $('projectName');
  if(projectNameEl) projectNameEl.addEventListener('input', (e)=>{ app.projectName = e.target.value; saveProject(); });
  const btnCopy = $('btnCopyLink');
  if(btnCopy) btnCopy.onclick = ()=>{
    if(!app.projectId) saveProject(); const url = new URL(location.href);
    url.searchParams.set('project', app.projectId); copyToClipboard(url.toString());
  };

  // Producteur
  const btnGeocode = $('btnGeocode');
  if(btnGeocode) btnGeocode.onclick = async ()=>{
    const q = $('addr').value?.trim(); if(!q) return showError('Saisir une adresse');
    setStatus('Géocodage…'); const r = await geocodeAdresse(q); if(!r) return setStatus('Géocodage impossible');
    app.addrLabel = r.label; setProducteur({ lat:r.lat, lon:r.lon }); app.map.setView([r.lat, r.lon], 14); setStatus('Adresse localisée');
  };
  const btnSetFromInputs = $('btnSetProducerFromInputs');
  if(btnSetFromInputs) btnSetFromInputs.onclick = ()=>{
    const la = Number($('prodLat').value), lo = Number($('prodLon').value);
    if(!Number.isFinite(la)||!Number.isFinite(lo)) return showError('Coordonnées producteur invalides');
    setProducteur({ lat:la, lon:lo }); app.map.setView([la, lo], 14);
  };
  const btnPlaceProducer = $('btnPlaceProducer');
  if(btnPlaceProducer) btnPlaceProducer.onclick = ()=>{
    app.placingProducer = !app.placingProducer; btnPlaceProducer.classList.toggle('primary', app.placingProducer);
    setStatus(app.placingProducer ? 'Clique sur la carte pour fixer le producteur' : 'Mode placement désactivé');
  };
  const btnClearProducer = $('btnClearProducer');
  if(btnClearProducer) btnClearProducer.onclick = clearProducteur;

  // Géolocalisation (HTML5)
  const btnLocate = $('btnLocate');
  if(btnLocate) btnLocate.onclick = ()=>{
    if(!navigator.geolocation) return showError('Géolocalisation non supportée');
    setStatus('Géolocalisation en cours…');
    navigator.geolocation.getCurrentPosition(pos=>{
      const { latitude, longitude } = pos.coords;
      app.map.setView([latitude, longitude], 15);
      if(!app.producteur){
        setProducteur({ lat:latitude, lon:longitude });
      }else{
        app.centreLibre = { lat:latitude, lon:longitude };
        app.layers.freeMarker.setLatLng([latitude, longitude]);
        $('lat').value = latitude.toFixed(6); $('lon').value = longitude.toFixed(6);
        redrawCircle(); refreshAll(); saveProject();
      }
      setStatus('Position GPS acquise');
    }, err=>{
      showError(`GPS KO: ${err.message||'inconnu'}`); setStatus('Géolocalisation indisponible');
    }, { enableHighAccuracy:true, timeout:10000, maximumAge:0 });
  };

  // Centre visuel
  document.querySelectorAll('input[name="centreMode"]').forEach(r=>{
    r.addEventListener('change', (e)=>{ app.centreMode = e.target.value; redrawCircle(); checkLegalPerimeter(); saveProject(); });
  });
  const latEl = $('lat'), lonEl = $('lon');
  if(latEl) latEl.addEventListener('change', e=>{ const v=Number(e.target.value); if(Number.isFinite(v)){ app.centreLibre.lat=v; app.layers.freeMarker.setLatLng([app.centreLibre.lat, app.centreLibre.lon]); redrawCircle(); checkLegalPerimeter(); saveProject(); }});
  if(lonEl) lonEl.addEventListener('change', e=>{ const v=Number(e.target.value); if(Number.isFinite(v)){ app.centreLibre.lon=v; app.layers.freeMarker.setLatLng([app.centreLibre.lat, app.centreLibre.lon]); redrawCircle(); checkLegalPerimeter(); saveProject(); }});

  // Diamètre légal & rayon visuel
  const applyDistMax = ()=>{
    const pv = $('distMaxPreset').value;
    if(pv==='perso'){
      const d = Number($('distMaxPerso').value); if(Number.isFinite(d)&&d>0) app.distMaxKm = d;
    } else { app.distMaxKm = Number(pv); $('distMaxPerso').value = ''; }
    const curExpl = Number($('distExplor').value);
    if(!Number.isFinite(curExpl) || curExpl<=0) { app.distExplorKm = app.distMaxKm; $('distExplor').value = app.distExplorKm; }
    redrawCircle(); checkLegalPerimeter(); saveProject();
  };
  const distMaxPreset = $('distMaxPreset'), distMaxPerso = $('distMaxPerso'), distExplor = $('distExplor');
  if(distMaxPreset) distMaxPreset.addEventListener('change', applyDistMax);
  if(distMaxPerso) distMaxPerso.addEventListener('change', applyDistMax);
  if(distExplor) distExplor.addEventListener('change', (e)=>{ const v=Number(e.target.value); if(Number.isFinite(v)&&v>0){ app.distExplorKm=v; redrawCircle(); checkLegalPerimeter(); saveProject(); }});

  const reseauSel = $('reseau'); if(reseauSel) reseauSel.addEventListener('change', e=>{ app.reseau = e.target.value; saveProject(); });

  // Actions carte
  const btnRecentre = $('btnRecentrer'); if(btnRecentre) btnRecentre.onclick = ()=>{ const c = getCentreRayon(); app.map.setView([c.lat, c.lon], 13); };
  const btnScan = $('btnScan'); if(btnScan) btnScan.onclick = scanCandidats;
  const btnSIS = $('btnChargerSIS'); if(btnSIS) btnSIS.onclick = loadSIS;

  // Participants
  const btnAddPart = $('btnAddPart');
  if(btnAddPart) btnAddPart.onclick = ()=>{
    const nom=$('partNom').value?.trim(); const lat=Number($('partLat').value), lon=Number($('partLon').value);
    const type=$('partType').value;
    if(!nom || !Number.isFinite(lat) || !Number.isFinite(lon)) return showError('Participant: champs incomplets');
    addParticipant({ id:crypto.randomUUID(), nom, lat, lon, type });
    $('partNom').value=''; $('partLat').value=''; $('partLon').value='';
  };
  const btnImportCsv = $('btnImportCsv');
  if(btnImportCsv) btnImportCsv.onclick = async ()=>{
    const f = $('fileCsv').files?.[0]; if(!f) return showError('Aucun fichier CSV sélectionné');
    const text = await f.text();
    const rows = text.trim().split(/\r?\n/), out=[]; const startIdx = rows[0]?.toLowerCase().includes('nom;') ? 1 : 0;
    for(let i=startIdx;i<rows.length;i++){
      const line = rows[i].trim(); if(!line) continue;
      const [nom, lat, lon, typeRaw] = line.split(';').map(s=>s?.trim());
      const la=Number(lat), lo=Number(lon), type=(typeRaw||'').toLowerCase();
      if(nom && Number.isFinite(la) && Number.isFinite(lo) && ['consumer','producer'].includes(type)) out.push({ id:crypto.randomUUID(), nom, lat:la, lon:lo, type });
    }
    out.forEach(addParticipant);
  };
  const btnExportCsv = $('btnExportCsv');
  if(btnExportCsv) btnExportCsv.onclick = ()=>{
    const rows = [['Nom','Lat','Lon','Type'], ...app.participants.map(p=>[p.nom,p.lat,p.lon,p.type])];
    const csv = rows.map(r=>r.join(';')).join('\n');
    const blob = new Blob([csv], { type:'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `participants_${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.csv`; a.click(); URL.revokeObjectURL(a.href);
  };

  // Storage
  const btnSave = $('btnSaveLocal'); if(btnSave) btnSave.onclick = ()=> saveProject(true);
  const btnLoad = $('btnLoadLocal'); if(btnLoad) btnLoad.onclick = ()=>{
    const id = app.projectId || localStorage.getItem(STORAGE_LAST); if(!id) return showError('Aucun projet à charger');
    const payload = loadProjectById(id); if(!payload) return showError('Projet introuvable'); applyProjectPayload(payload);
  };
  const btnDel = $('btnDeleteLocal'); if(btnDel) btnDel.onclick = ()=> deleteProject();

  // Presets de zone (STD / PERI / RURAL / EPCI)
  document.querySelectorAll('#zoneBtns .seg-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.querySelectorAll('#zoneBtns .seg-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');

      const zone = btn.getAttribute('data-zone'); app.zoneRegl = zone;
      const dmax = Number(btn.getAttribute('data-dmax'));
      if(Number.isFinite(dmax)){
        app.distMaxKm = dmax;
        const curExpl = Number($('distExplor').value);
        if(!Number.isFinite(curExpl) || curExpl<=0){
          app.distExplorKm = app.distMaxKm; $('distExplor').value = app.distExplorKm;
        }
        $('distMaxPreset').value = [2,10,20].includes(app.distMaxKm) ? String(app.distMaxKm) : 'perso';
        $('distMaxPerso').value = ($('distMaxPreset').value==='perso') ? app.distMaxKm : '';
      }
      redrawCircle(); checkLegalPerimeter(); saveProject();
    });
  });

  // Toggle rapide 20 km (usage autorisé) avec “undo”
  let prevDistBeforeBoost = null;
  const btnBoost20 = $('btnBoost20');
  if(btnBoost20) btnBoost20.onclick = ()=>{
    if(app.distMaxKm !== 20){
      prevDistBeforeBoost = app.distMaxKm;
      app.distMaxKm = 20;
      $('distMaxPreset').value = '20'; $('distMaxPerso').value='';
    } else {
      app.distMaxKm = prevDistBeforeBoost ?? 2;
      $('distMaxPreset').value = [2,10,20].includes(app.distMaxKm) ? String(app.distMaxKm) : 'perso';
      $('distMaxPerso').value = ($('distMaxPreset').value==='perso') ? app.distMaxKm : '';
    }
    const curExpl = Number($('distExplor').value);
    if(!Number.isFinite(curExpl) || curExpl<=0){
      app.distExplorKm = app.distMaxKm; $('distExplor').value = app.distExplorKm;
    }
    redrawCircle(); checkLegalPerimeter(); saveProject();
  };
}

// ========= Refresh =========
function refreshCommune(){ const c=getCentreRayon(); getCommuneParCoord(c.lat,c.lon).then(x=>{ if(x) $('communePill').textContent = `Commune: ${x.nom}${x.epci?.nom ? ' — EPCI: '+x.epci.nom : ''}`; }); }
function refreshAll(){ refreshCommune(); checkLegalPerimeter(); }

// ========= Bootstrap =========
(async function init(){
  try{
    setStatus('Initialisation…'); setupMap(); wireUI();
    const candidateId = detectStartupProjectId();
    if(candidateId){
      const payload = loadProjectById(candidateId);
      if(payload){
        app.projectId = candidateId; applyProjectPayload(payload);
        localStorage.setItem(STORAGE_LAST, app.projectId);
        const url = new URL(location.href); url.searchParams.set('project', app.projectId); history.replaceState(null,'',url.toString());
        return;
      }
    }
    app.projectId = newId(); app.distExplorKm = app.distMaxKm; $('distExplor') && ($('distExplor').value = app.distExplorKm);
    drawParticipants(); refreshAll(); saveProject(); setStatus('Prêt');
  }catch(e){ showError(`Init KO: ${e.message}`); setStatus('Erreur (voir détails)'); }
})();
