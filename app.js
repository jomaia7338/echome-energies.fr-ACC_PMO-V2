// ========= Helpers UI / Erreurs =========
const $ = (id) => document.getElementById(id);
const setStatus = (m) => { $('status').textContent = m; };
const showError = (m) => {
  const box = $('error-box');
  box.classList.remove('hidden');
  box.textContent += `[${new Date().toLocaleTimeString()}] ${m}\n`;
  console.error(m);
};
const copyToClipboard = async (text) => {
  try { await navigator.clipboard.writeText(text); setStatus('Lien copié'); }
  catch { showError('Impossible de copier le lien'); }
};

// ========= Fetch robuste =========
async function fetchJSON(url, { method='GET', body, headers={}, timeoutMs=15000, retries=1, expect='auto' } = {}){
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), timeoutMs);
  try{
    const res = await fetch(url, { method, body, headers, signal: ctrl.signal, cache:'no-store' });
    if(!res.ok){
      const txt = await res.text().catch(()=> '');
      throw new Error(`HTTP ${res.status} on ${url} :: ${txt.slice(0,240)}`);
    }
    const ct = res.headers.get('content-type') || '';
    if(expect==='text') return await res.text();
    if(expect==='json' || ct.includes('application/json')) return await res.json();
    const raw = await res.text(); try{ return JSON.parse(raw); }catch{ return raw; }
  }catch(e){
    if(retries>0){ await new Promise(r=>setTimeout(r, Math.min(2500, timeoutMs/3))); return fetchJSON(url,{method,body,headers,timeoutMs:Math.round(timeoutMs*1.5),retries:retries-1,expect}); }
    throw e;
  }finally{ clearTimeout(t); }
}

// ========= Services externes =========
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
async function overpass(query){
  try{
    const body = new URLSearchParams({ data: query }).toString();
    return await fetchJSON(OVERPASS_URL, {
      method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8'},
      body, timeoutMs:20000, retries:2, expect:'json'
    });
  }catch(e){ showError(`Overpass KO: ${e.message}`); return null; }
}
async function getCommuneParCoord(lat, lon){
  const url = `https://geo.api.gouv.fr/communes?lat=${lat}&lon=${lon}&fields=nom,code,epci&format=json&type=commune`;
  try{
    const arr = await fetchJSON(url, { timeoutMs:10000, retries:1, expect:'json' });
    if(!Array.isArray(arr) || arr.length === 0) throw new Error('Aucune commune trouvée');
    return arr[0];
  }catch(e){ showError(`Commune/EPCI KO: ${e.message}`); return null; }
}
async function geocodeAdresse(q){
  const url = `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(q)}&limit=1`;
  try{
    const json = await fetchJSON(url, { timeoutMs:10000, retries:1, expect:'json' });
    const feat = json?.features?.[0];
    if(!feat) throw new Error('Adresse introuvable');
    const [lon, lat] = feat.geometry.coordinates;
    const label = feat.properties?.label || q;
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

// ========= État appli / Projets =========
const STORAGE_NS = 'echome-acc-terrain';
const STORAGE_LAST = `${STORAGE_NS}:lastProjectId`;
const projectKey = (id) => `${STORAGE_NS}:project:${id}`;
const newId = () => (crypto?.randomUUID?.() || String(Date.now()));

const prodIcon = L.divIcon({ className:'prod-icon', html:'<div class="pin"></div>', iconSize:[24,24], iconAnchor:[12,24] });

const app = {
  projectId: null,
  projectName: '',
  addrLabel: '',

  map:null,

  // Producteur
  producteur: null, // {lat, lon}
  centreMode: 'producer', // 'producer' | 'free'
  placingProducer: false,

  // Point libre (centre visuel pour le cercle de prospection)
  centreLibre: { lat:45.191, lon:5.684 },

  // Paramètres périmètre
  distMaxKm: 2,       // DIAMÈTRE légal (2/10/20/...)
  distExplorKm: 2,    // Rayon du cercle de prospection visuel

  reseau: 'BT',

  layers:{
    producerMarker:null, freeMarker:null, cercle:null, cand:L.layerGroup(),
    part:L.layerGroup(), sis:L.layerGroup(), legal:L.layerGroup()
  },
  candidats:[], participants:[]
};

// ========= Carte & Producteur =========
function getCentreRayon(){
  if (app.centreMode === 'producer' && app.producteur) return app.producteur;
  return app.centreLibre;
}
function setupMap(){
  app.map = L.map('map', { zoomControl:true }).setView([app.centreLibre.lat, app.centreLibre.lon], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution:'© OSM' }).addTo(app.map);

  app.layers.freeMarker = L.marker([app.centreLibre.lat, app.centreLibre.lon], { draggable:true, title:'Point libre' }).addTo(app.map);
  app.layers.freeMarker.on('dragend', ()=>{
    const { lat, lng } = app.layers.freeMarker.getLatLng();
    app.centreLibre = { lat, lon: lng };
    $('lat').value = lat.toFixed(6); $('lon').value = lng.toFixed(6);
    redrawCircle(); refreshAll(); saveProject();
  });

  app.map.on('click', (e)=>{
    if (app.placingProducer){
      setProducteur({ lat:e.latlng.lat, lon:e.latlng.lng });
      app.placingProducer = false;
      $('btnPlaceProducer').classList.remove('primary');
      return;
    }
    app.centreLibre = { lat:e.latlng.lat, lon:e.latlng.lng };
    app.layers.freeMarker.setLatLng([app.centreLibre.lat, app.centreLibre.lon]);
    $('lat').value = app.centreLibre.lat.toFixed(6);
    $('lon').value = app.centreLibre.lon.toFixed(6);
    redrawCircle(); refreshAll(); saveProject();
  });

  app.layers.cand.addTo(app.map);
  app.layers.part.addTo(app.map);
  app.layers.sis.addTo(app.map);
  app.layers.legal.addTo(app.map); // lignes de contrôle

  redrawCircle();
}
function setProducteur({lat, lon}){
  app.producteur = { lat, lon };
  $('prodLat').value = lat.toFixed(6);
  $('prodLon').value = lon.toFixed(6);
  if(!app.layers.producerMarker){
    app.layers.producerMarker = L.marker([lat,lon], { draggable:true, title:'Producteur', icon: prodIcon }).addTo(app.map);
    app.layers.producerMarker.on('dragend', ()=>{
      const { lat, lng } = app.layers.producerMarker.getLatLng();
      app.producteur = { lat, lon: lng };
      $('prodLat').value = lat.toFixed(6);
      $('prodLon').value = lon.toFixed(6);
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
function redrawCircle(){
  const centre = getCentreRayon();
  const radius = Math.max(1, (Number($('distExplor')?.value) || app.distExplorKm) * 1000);
  if(app.layers.cercle) app.map.removeLayer(app.layers.cercle);
  app.layers.cercle = L.circle([centre.lat, centre.lon], { radius, color:'#37C3AF', weight:1, fillOpacity:.08 }).addTo(app.map);
}

// ========= Participants & Conformité =========
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
function addParticipant(p){
  app.participants.push(p);
  drawParticipants();
  renderParticipantsList();
  saveProject();
}
function removeParticipant(id){
  app.participants = app.participants.filter(x=>x.id!==id);
  drawParticipants();
  renderParticipantsList();
  saveProject();
}
function renderParticipantsList(){
  const wrap = $('listParts'); wrap.innerHTML = '';
  app.participants.forEach(p=>{
    const div = document.createElement('div');
    div.className = 'part';
    div.innerHTML = `
      <div>
        <div><b>${p.nom}</b> — ${p.type}</div>
        <div class="meta">${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}</div>
      </div>
      <div>
        <button data-id="${p.id}" class="danger">Supprimer</button>
      </div>`;
    div.querySelector('button').onclick = (e)=> removeParticipant(e.currentTarget.getAttribute('data-id'));
    wrap.appendChild(div);
  });
}

// Vérifie la contrainte "distance max entre les deux participants les plus éloignés <= distMaxKm"
function checkLegalPerimeter(){
  app.layers.legal.clearLayers();
  const pts = [];
  if(app.producteur) pts.push({ ...app.producteur, label:'Producteur' });
  app.participants.forEach(p=> pts.push({ lat:p.lat, lon:p.lon, label:p.nom }));

  let ok = true, worst = {d:0,a:null,b:null};
  for(let i=0;i<pts.length;i++){
    for(let j=i+1;j<pts.length;j++){
      const d = haversineMeters(pts[i], pts[j]) / 1000;
      if(d > app.distMaxKm){ // non conforme : trace en rouge
        ok = false;
        L.polyline([[pts[i].lat,pts[i].lon],[pts[j].lat,pts[j].lon]], { color:'#cc2b4a', weight:2, opacity:.9 })
          .addTo(app.layers.legal)
          .bindPopup(`${pts[i].label} ↔ ${pts[j].label}<br><b>${d.toFixed(2)} km</b> (> ${app.distMaxKm} km)`);
      } else {
        // optionnel : montrer les liens conformes en discret
        // L.polyline([[pts[i].lat,pts[i].lon],[pts[j].lat,pts[j].lon]], { color:'#2a7', weight:1, opacity:.2 }).addTo(app.layers.legal);
      }
      if(d > worst.d) worst = { d, a:pts[i], b:pts[j] };
    }
  }
  $('kpiLegal').textContent = pts.length<2 ? '—' : (ok ? 'Conforme ✔︎' : 'Non conforme ✖︎');
  // KPI "dans le rayon visuel" (utile terrain)
  const c = getCentreRayon();
  const rKm = (Number($('distExplor')?.value) || app.distExplorKm);
  const inScan = app.participants.filter(p => (haversineMeters(c, {lat:p.lat, lon:p.lon})/1000) <= rKm).length;
  $('kpiRayon').textContent = inScan;
}

// ========= Candidats Overpass =========
function overpassQueryCandidats({ lat, lon, distKm, cats }){
  const r = Math.max(1, Math.round(distKm*1000)); // m
  const blocks = [];
  if(cats.has('education')) blocks.push(`node(around:${r},${lat},${lon})["amenity"~"school|college|university"];`);
  if(cats.has('sante'))     blocks.push(`node(around:${r},${lat},${lon})["amenity"~"clinic|hospital|doctors|pharmacy"];`);
  if(cats.has('adm'))       blocks.push(`node(around:${r},${lat},${lon})["amenity"~"townhall|public_building|library"];`);
  if(cats.has('sport'))     blocks.push(`node(around:${r},${lat},${lon})["leisure"~"sports_centre|stadium|pitch|swimming_pool"];`);
  if(cats.has('commerce'))  blocks.push(`node(around:${r},${lat},${lon})["shop"]; node(around:${r},${lat},${lon})["amenity"="marketplace"];`);
  if(cats.has('industrie')) blocks.push(`node(around:${r},${lat},${lon})["industrial"];`);
  if(cats.has('parking'))   blocks.push(`node(around:${r},${lat},${lon})["amenity"="parking"];`);
  return `[out:json][timeout:25];( ${blocks.join('\n')} );out center;`;
}
function normalizeOSM(elements){
  const out=[];
  (elements||[]).forEach(e=>{
    const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
    if(Number.isFinite(lat) && Number.isFinite(lon)){
      out.push({ id:`osm-${e.type}-${e.id}`, nom: e.tags?.name || e.tags?.ref || '—', lat, lon, raw:e.tags||{} });
    }
  });
  return out;
}
async function scanCandidats(){
  setStatus('Scan OSM…');
  const cats = new Set([...document.querySelectorAll('.cat:checked')].map(i=>i.value));
  if(cats.size===0){ setStatus('Aucune catégorie sélectionnée'); return; }
  const c = getCentreRayon();
  const dist = Number($('distExplor')?.value) || app.distExplorKm || app.distMaxKm;
  const q = overpassQueryCandidats({ lat:c.lat, lon:c.lon, distKm:dist, cats });
  const data = await overpass(q);
  app.layers.cand.clearLayers();
  app.candidats = [];
  if(data && Array.isArray(data.elements)){
    app.candidats = normalizeOSM(data.elements);
    app.candidats.forEach(x=>{
      L.circleMarker([x.lat,x.lon],{ radius:6, color:'#ff6b7a', weight:2, fillOpacity:.7 })
        .bindPopup(`<b>${x.nom}</b><br>${x.lat.toFixed(5)}, ${x.lon.toFixed(5)}`)
        .addTo(app.layers.cand);
    });
  }
  $('kpiCand').textContent = app.candidats.length;
  setStatus('Prêt');
}

// ========= POI SIS =========
function overpassSISQuery({ lat, lon, distKm }){
  const r = Math.max(1, Math.round(distKm*1000));
  return `
    [out:json][timeout:25];
    (
      node(around:${r},${lat},${lon})["emergency"="fire_hydrant"];
      node(around:${r},${lat},${lon})["amenity"="fire_station"];
      way(around:${r},${lat},${lon})["amenity"="fire_station"];
      relation(around:${r},${lat},${lon})["amenity"="fire_station"];
    );
    out center;`;
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

// ========= Commune/EPCI + KPI =========
function refreshCommune(){
  const c = getCentreRayon();
  getCommuneParCoord(c.lat, c.lon).then(x=>{
    if(x) $('communePill').textContent = `Commune: ${x.nom}${x.epci?.nom ? ' — EPCI: '+x.epci.nom : ''}`;
  });
}

// ========= Storage / Projets =========
function getCurrentProjectPayload(){
  return {
    __v:3, // bump version (diamètre légal)
    savedAt:new Date().toISOString(),
    state:{
      projectName: app.projectName,
      addrLabel: app.addrLabel,
      producteur: app.producteur,
      centreMode: app.centreMode,
      centreLibre: app.centreLibre,
      distMaxKm: app.distMaxKm,
      distExplorKm: app.distExplorKm,
      reseau: app.reseau,
      participants: app.participants
    }
  };
}
function saveProject(explicit=false){
  try{
    if(!app.projectId) app.projectId = newId();
    const key = projectKey(app.projectId);
    localStorage.setItem(key, JSON.stringify(getCurrentProjectPayload()));
    localStorage.setItem(STORAGE_LAST, app.projectId);
    if (explicit) setStatus('Projet enregistré (local)');
    const url = new URL(location.href);
    url.searchParams.set('project', app.projectId);
    history.replaceState(null, '', url.toString());
  }catch(e){ showError(`Sauvegarde KO: ${e.message}`); }
}
function loadProjectById(id){
  try{
    const raw = localStorage.getItem(projectKey(id));
    if(!raw) return null;
    return JSON.parse(raw);
  }catch(e){ showError('Projet corrompu'); return null; }
}
function applyProjectPayload(payload){
  const s = payload?.state || {};
  app.projectName = s.projectName || '';
  app.addrLabel = s.addrLabel || '';
  app.producteur = s.producteur || null;
  app.centreMode = s.centreMode || 'producer';
  app.centreLibre = s.centreLibre || app.centreLibre;
  app.distMaxKm = s.distMaxKm || 2;
  app.distExplorKm = s.distExplorKm || app.distMaxKm;
  app.reseau = s.reseau || app.reseau;
  app.participants = Array.isArray(s.participants) ? s.participants : [];

  $('projectName').value = app.projectName;
  $('addr').value = app.addrLabel;

  if(app.producteur){ setProducteur(app.producteur); } else { clearProducteur(); }
  $('prodLat').value = app.producteur ? app.producteur.lat.toFixed(6) : '';
  $('prodLon').value = app.producteur ? app.producteur.lon.toFixed(6) : '';

  // UI périmètre
  $('distMaxPreset').value = [2,10,20].includes(Number(app.distMaxKm)) ? String(app.distMaxKm) : 'perso';
  if($('distMaxPreset').value==='perso') $('distMaxPerso').value = app.distMaxKm;
  $('distExplor').value = app.distExplorKm;

  // Point libre
  $('lat').value = app.centreLibre.lat.toFixed(6);
  $('lon').value = app.centreLibre.lon.toFixed(6);

  document.querySelectorAll('input[name="centreMode"]').forEach(r=> r.checked = (r.value === app.centreMode));
  if(app.layers.freeMarker) app.layers.freeMarker.setLatLng([app.centreLibre.lat, app.centreLibre.lon]);

  renderParticipantsList(); drawParticipants(); refreshCommune();
  setStatus('Projet chargé');
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
  if(p) return p;
  try { return localStorage.getItem(STORAGE_LAST) || null; } catch { return null; }
}

// ========= Wiring UI =========
function wireUI(){
  // Dossier
  $('projectName').addEventListener('input', (e)=>{ app.projectName = e.target.value; saveProject(); });
  $('btnCopyLink').onclick = ()=>{
    if(!app.projectId) saveProject();
    const url = new URL(location.href);
    url.searchParams.set('project', app.projectId);
    copyToClipboard(url.toString());
  };

  // Producteur
  $('btnGeocode').onclick = async ()=>{
    const q = $('addr').value?.trim();
    if(!q) return showError('Saisir une adresse');
    setStatus('Géocodage…');
    const r = await geocodeAdresse(q);
    if(!r) return setStatus('Géocodage impossible');
    app.addrLabel = r.label;
    setProducteur({ lat:r.lat, lon:r.lon });
    app.map.setView([r.lat, r.lon], 14);
    setStatus('Adresse localisée');
  };
  $('btnSetProducerFromInputs').onclick = ()=>{
    const la = Number($('prodLat').value), lo = Number($('prodLon').value);
    if(!Number.isFinite(la)||!Number.isFinite(lo)) return showError('Coordonnées producteur invalides');
    setProducteur({ lat:la, lon:lo });
    app.map.setView([la, lo], 14);
  };
  $('btnPlaceProducer').onclick = ()=>{
    app.placingProducer = !app.placingProducer;
    $('btnPlaceProducer').classList.toggle('primary', app.placingProducer);
    setStatus(app.placingProducer ? 'Clique sur la carte pour fixer le producteur' : 'Mode placement désactivé');
  };
  $('btnClearProducer').onclick = clearProducteur;

  // Centre du cercle visuel
  document.querySelectorAll('input[name="centreMode"]').forEach(r=>{
    r.addEventListener('change', (e)=>{
      app.centreMode = e.target.value;
      redrawCircle(); checkLegalPerimeter(); saveProject();
    });
  });

  // Point libre
  $('lat').addEventListener('change', e=>{ const v=Number(e.target.value); if(Number.isFinite(v)){ app.centreLibre.lat=v; app.layers.freeMarker.setLatLng([app.centreLibre.lat, app.centreLibre.lon]); redrawCircle(); checkLegalPerimeter(); saveProject(); }});
  $('lon').addEventListener('change', e=>{ const v=Number(e.target.value); if(Number.isFinite(v)){ app.centreLibre.lon=v; app.layers.freeMarker.setLatLng([app.centreLibre.lat, app.centreLibre.lon]); redrawCircle(); checkLegalPerimeter(); saveProject(); }});

  // Distance maximale (diamètre légal)
  const applyDistMax = ()=>{
    const pv = $('distMaxPreset').value;
    if(pv==='perso'){
      const d = Number($('distMaxPerso').value);
      if(Number.isFinite(d) && d>0) app.distMaxKm = d;
    } else {
      app.distMaxKm = Number(pv);
      $('distMaxPerso').value = '';
    }
    // Par défaut, on aligne le rayon d’exploration si vide
    const curExpl = Number($('distExplor').value);
    if(!Number.isFinite(curExpl) || curExpl<=0) { app.distExplorKm = app.distMaxKm; $('distExplor').value = app.distExplorKm; }
    checkLegalPerimeter(); saveProject();
  };
  $('distMaxPreset').addEventListener('change', applyDistMax);
  $('distMaxPerso').addEventListener('change', applyDistMax);

  // Rayon de prospection visuel
  $('distExplor').addEventListener('change', (e)=>{
    const v = Number(e.target.value);
    if(Number.isFinite(v) && v>0){ app.distExplorKm = v; redrawCircle(); checkLegalPerimeter(); saveProject(); }
  });

  // Réseau
  $('reseau').addEventListener('change', e=>{ app.reseau = e.target.value; saveProject(); });

  // Actions carte
  $('btnRecentrer').onclick = ()=>{
    const c = getCentreRayon();
    app.map.setView([c.lat, c.lon], 13);
  };
  $('btnScan').onclick = scanCandidats;
  $('btnChargerSIS').onclick = loadSIS;

  // Participants
  $('btnAddPart').onclick = ()=>{
    const nom=$('partNom').value?.trim();
    const lat=Number($('partLat').value), lon=Number($('partLon').value);
    const type=$('partType').value;
    if(!nom || !Number.isFinite(lat) || !Number.isFinite(lon)) return showError('Participant: champs incomplets');
    addParticipant({ id:crypto.randomUUID(), nom, lat, lon, type });
    $('partNom').value=''; $('partLat').value=''; $('partLon').value='';
  };
  $('btnImportCsv').onclick = async ()=>{
    const f = $('fileCsv').files?.[0];
    if(!f) return showError('Aucun fichier CSV sélectionné');
    const text = await f.text();
    // CSV: Nom;Lat;Lon;consumer|producer
    const rows = text.trim().split(/\r?\n/), out=[];
    const startIdx = rows[0]?.toLowerCase().includes('nom;') ? 1 : 0;
    for(let i=startIdx;i<rows.length;i++){
      const line = rows[i].trim(); if(!line) continue;
      const [nom, lat, lon, typeRaw] = line.split(';').map(s=>s?.trim());
      const type=(typeRaw||'').toLowerCase();
      const la=Number(lat), lo=Number(lon);
      if(nom && Number.isFinite(la) && Number.isFinite(lo) && ['consumer','producer'].includes(type)){
        out.push({ id: crypto.randomUUID(), nom, lat:la, lon:lo, type });
      }
    }
    out.forEach(addParticipant);
  };
  $('btnExportCsv').onclick = ()=>{
    const rows = [['Nom','Lat','Lon','Type'], ...app.participants.map(p=>[p.nom,p.lat,p.lon,p.type])];
    const csv = rows.map(r=>r.join(';')).join('\n');
    const blob = new Blob([csv], { type:'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `participants_${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.csv`;
    a.click(); URL.revokeObjectURL(a.href);
  };

  // Storage
  $('btnSaveLocal').onclick = ()=> saveProject(true);
  $('btnLoadLocal').onclick = ()=>{
    const id = app.projectId || localStorage.getItem(STORAGE_LAST);
    if(!id) return showError('Aucun projet à charger');
    const payload = loadProjectById(id);
    if(!payload) return showError('Projet introuvable');
    applyProjectPayload(payload);
  };
  $('btnDeleteLocal').onclick = ()=> deleteProject();
}

// ========= Bootstrap =========
(async function init(){
  try{
    setStatus('Initialisation…');
    const candidateId = detectStartupProjectId();
    setupMap(); wireUI();

    if(candidateId){
      const payload = loadProjectById(candidateId);
      if(payload){
        app.projectId = candidateId;
        applyProjectPayload(payload);
        localStorage.setItem(STORAGE_LAST, app.projectId);
        const url = new URL(location.href);
        url.searchParams.set('project', app.projectId);
        history.replaceState(null, '', url.toString());
        return;
      }
    }
    // Nouveau projet (vierge)
    app.projectId = newId();
    // Aligne exploration sur distance max au démarrage
    app.distExplorKm = app.distMaxKm;
    $('distExplor') && ($('distExplor').value = app.distExplorKm);
    drawParticipants(); refreshCommune(); checkLegalPerimeter();
    saveProject(); // crée l’entrée + lastProject
    setStatus('Prêt');
  }catch(e){
    showError(`Init KO: ${e.message}`); setStatus('Erreur (voir détails)');
  }
})();