// ---------- Helpers UI / Erreurs ----------
const $ = (id) => document.getElementById(id);
const setStatus = (m) => { $('status').textContent = m; };
const showError = (m) => {
  const box = $('error-box');
  box.classList.remove('hidden');
  box.textContent += `[${new Date().toLocaleTimeString()}] ${m}\n`;
  console.error(m);
};

// ---------- Fetch robuste ----------
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

// ---------- Services externes ----------
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
    return arr[0]; // { nom, code, epci? }
  }catch(e){ showError(`Commune/EPCI KO: ${e.message}`); return null; }
}

// ---------- Géodésie ----------
function haversineMeters(a,b){
  const R=6371000, toRad=d=>d*Math.PI/180;
  const dLat=toRad(b.lat-a.lat), dLon=toRad(b.lon-a.lon);
  const lat1=toRad(a.lat), lat2=toRad(b.lat);
  const h=Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(h));
}
const pointDansRayon = (centre, pt, rayonKm) => haversineMeters(centre, pt) <= (rayonKm*1000)+1;

// ---------- État appli ----------
const STORAGE_KEY='echome-acc-terrain-v1';
const app = {
  map:null, centre:{ lat:45.191, lon:5.684 }, rayonKm:2, reseau:'BT',
  layers:{ centrale:null, cercle:null, cand:L.layerGroup(), part:L.layerGroup(), sis:L.layerGroup() },
  candidats:[], participants:[]
};

// ---------- Carte ----------
function setupMap(){
  app.map = L.map('map', { zoomControl:true }).setView([app.centre.lat, app.centre.lon], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution:'© OSM' }).addTo(app.map);

  // Marqueur centrale
  app.layers.centrale = L.marker([app.centre.lat, app.centre.lon], { draggable:true, title:'Centrale' }).addTo(app.map);
  app.layers.centrale.on('dragend', ()=>{
    const { lat, lng } = app.layers.centrale.getLatLng();
    app.centre = { lat, lon: lng };
    $('lat').value = lat.toFixed(6); $('lon').value = lng.toFixed(6);
    redrawCircle(); refreshAll();
  });

  // Clic carte pour déplacer
  app.map.on('click', (e)=>{
    app.centre = { lat:e.latlng.lat, lon:e.latlng.lng };
    app.layers.centrale.setLatLng([app.centre.lat, app.centre.lon]);
    $('lat').value = app.centre.lat.toFixed(6); $('lon').value = app.centre.lon.toFixed(6);
    redrawCircle(); refreshAll();
  });

  app.layers.cand.addTo(app.map);
  app.layers.part.addTo(app.map);
  app.layers.sis.addTo(app.map);

  redrawCircle();
}
function redrawCircle(){
  const radius = Math.max(1, app.rayonKm*1000);
  if(app.layers.cercle) app.map.removeLayer(app.layers.cercle);
  app.layers.cercle = L.circle([app.centre.lat, app.centre.lon], { radius, color:'#37C3AF', weight:1, fillOpacity:.08 }).addTo(app.map);
}

// ---------- Participants ----------
function drawParticipants(){
  app.layers.part.clearLayers();
  app.participants.forEach(p=>{
    const color = p.type==='producer' ? '#f5b841' : '#4ea2ff';
    L.circleMarker([p.lat,p.lon],{ radius:6, color, weight:2, fillOpacity:.7 })
      .bindPopup(`<b>${p.nom}</b><br>${p.type}<br>${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`)
      .addTo(app.layers.part);
  });
  $('kpiPart').textContent = app.participants.length;
}
function addParticipant(p){
  app.participants.push(p);
  drawParticipants(); refreshRayonKPI();
  renderParticipantsList();
}
function removeParticipant(id){
  app.participants = app.participants.filter(x=>x.id!==id);
  drawParticipants(); refreshRayonKPI();
  renderParticipantsList();
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

// ---------- Candidats Overpass ----------
function overpassQueryCandidats({ lat, lon, rayonKm, cats }){
  const r = Math.max(1, Math.round(rayonKm*1000)); // m
  const blocks = [];

  if(cats.has('education')){
    blocks.push(`node(around:${r},${lat},${lon})["amenity"~"school|college|university"];`);
  }
  if(cats.has('sante')){
    blocks.push(`node(around:${r},${lat},${lon})["amenity"~"clinic|hospital|doctors|pharmacy"];`);
  }
  if(cats.has('adm')){
    blocks.push(`node(around:${r},${lat},${lon})["amenity"~"townhall|public_building|library"];`);
  }
  if(cats.has('sport')){
    blocks.push(`node(around:${r},${lat},${lon})["leisure"~"sports_centre|stadium|pitch|swimming_pool"];`);
  }
  if(cats.has('commerce')){
    blocks.push(`node(around:${r},${lat},${lon})["shop"]; node(around:${r},${lat},${lon})["amenity"="marketplace"];`);
  }
  if(cats.has('industrie')){
    blocks.push(`node(around:${r},${lat},${lon})["industrial"];`);
  }
  if(cats.has('parking')){
    blocks.push(`node(around:${r},${lat},${lon})["amenity"="parking"];`);
  }

  return `
    [out:json][timeout:25];
    (
      ${blocks.join('\n')}
    );
    out center;
  `;
}
function normalizeOSM(elements){
  const out=[];
  (elements||[]).forEach(e=>{
    const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
    if(Number.isFinite(lat) && Number.isFinite(lon)){
      out.push({
        id: `osm-${e.type}-${e.id}`,
        nom: e.tags?.name || e.tags?.['ref'] || '—',
        lat, lon,
        raw: e.tags||{}
      });
    }
  });
  return out;
}
async function scanCandidats(){
  setStatus('Scan OSM…');
  const cats = new Set([...document.querySelectorAll('.cat:checked')].map(i=>i.value));
  if(cats.size===0){ setStatus('Aucune catégorie sélectionnée'); return; }
  const q = overpassQueryCandidats({ lat:app.centre.lat, lon:app.centre.lon, rayonKm:app.rayonKm, cats });
  const data = await overpass(q);
  app.layers.cand.clearLayers();
  app.candidats = [];
  if(data && Array.isArray(data.elements)){
    app.candidats = normalizeOSM(data.elements);
    app.candidats.forEach(c=>{
      L.circleMarker([c.lat,c.lon],{ radius:6, color:'#ff6b7a', weight:2, fillOpacity:.7 })
        .bindPopup(`<b>${c.nom}</b><br>${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}`)
        .addTo(app.layers.cand);
    });
  }
  $('kpiCand').textContent = app.candidats.length;
  setStatus('Prêt');
}

// ---------- POI SIS ----------
function overpassSISQuery({ lat, lon, rayonKm }){
  const r = Math.max(1, Math.round(rayonKm*1000));
  return `
    [out:json][timeout:25];
    (
      node(around:${r},${lat},${lon})["emergency"="fire_hydrant"];
      node(around:${r},${lat},${lon})["amenity"="fire_station"];
      way(around:${r},${lat},${lon})["amenity"="fire_station"];
      relation(around:${r},${lat},${lon})["amenity"="fire_station"];
    );
    out center;
  `;
}
async function loadSIS(){
  setStatus('Chargement SIS…');
  const q = overpassSISQuery({ lat:app.centre.lat, lon:app.centre.lon, rayonKm:app.rayonKm });
  const data = await overpass(q);
  app.layers.sis.clearLayers();
  let cnt=0;
  if(data && Array.isArray(data.elements)){
    normalizeOSM(data.elements).forEach(p=>{
      cnt++;
      L.circleMarker([p.lat,p.lon],{ radius:6, color:'#ff6b7a', weight:2, fillOpacity:.7 })
        .bindPopup(`<b>SIS</b><br>${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`)
        .addTo(app.layers.sis);
    });
  }
  setStatus('Prêt');
}

// ---------- Commune/EPCI + KPI rayon ----------
function refreshCommune(){
  getCommuneParCoord(app.centre.lat, app.centre.lon).then(c=>{
    if(c) $('communePill').textContent = `Commune: ${c.nom}${c.epci?.nom ? ' — EPCI: '+c.epci.nom : ''}`;
  });
}
function refreshRayonKPI(){
  const n = app.participants.filter(p=> pointDansRayon(app.centre, {lat:p.lat, lon:p.lon}, app.rayonKm)).length;
  $('kpiRayon').textContent = n;
}

// ---------- CSV ----------
function parseParticipantsCSV(text){
  const rows = text.trim().split(/\r?\n/), out=[], errors=[];
  // Support entête
  const startIdx = rows[0]?.toLowerCase().includes('nom;') ? 1 : 0;
  for(let i=startIdx;i<rows.length;i++){
    const line = rows[i].trim(); if(!line) continue;
    const [nom, lat, lon, typeRaw] = line.split(';').map(s=>s?.trim());
    const type=(typeRaw||'').toLowerCase();
    if(!nom || !lat || !lon || !['consumer','producer'].includes(type)){ errors.push(`L${i+1}: "${line}"`); continue; }
    const la=Number(lat), lo=Number(lon);
    if(!Number.isFinite(la)||!Number.isFinite(lo)){ errors.push(`L${i+1}: coords invalides`); continue; }
    out.push({ id: crypto.randomUUID(), nom, lat:la, lon:lo, type });
  }
  return { out, errors };
}
function exportCSV(){
  const rows = [['Nom','Lat','Lon','Type'], ...app.participants.map(p=>[p.nom,p.lat,p.lon,p.type])];
  const csv = rows.map(r=>r.join(';')).join('\n');
  const blob = new Blob([csv], { type:'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `participants_${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.csv`;
  a.click(); URL.revokeObjectURL(a.href);
}

// ---------- Storage ----------
function saveProject(){
  try{
    const payload = { __v:1, savedAt:new Date().toISOString(), state:{
      centre: app.centre, rayonKm: app.rayonKm, reseau: app.reseau, participants: app.participants
    }};
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    setStatus('Projet enregistré (local)');
  }catch(e){ showError(`Sauvegarde KO: ${e.message}`); }
}
function loadProject(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return null;
    return JSON.parse(raw);
  }catch(e){ showError('Projet corrompu'); return null; }
}
function deleteProject(){ localStorage.removeItem(STORAGE_KEY); setStatus('Projet supprimé (local)'); }

// ---------- Wiring UI ----------
function wireUI(){
  // Champs centre
  $('lat').value = app.centre.lat.toFixed(6);
  $('lon').value = app.centre.lon.toFixed(6);
  $('lat').addEventListener('change', e=>{ const v=Number(e.target.value); if(Number.isFinite(v)){ app.centre.lat=v; app.layers.centrale.setLatLng([app.centre.lat, app.centre.lon]); redrawCircle(); refreshAll(); }});
  $('lon').addEventListener('change', e=>{ const v=Number(e.target.value); if(Number.isFinite(v)){ app.centre.lon=v; app.layers.centrale.setLatLng([app.centre.lat, app.centre.lon]); redrawCircle(); refreshAll(); }});

  // Rayon presets
  const applyRayon = ()=>{
    const pv = $('rayonPreset').value;
    if(pv==='perso'){
      const r = Number($('rayonPerso').value);
      if(Number.isFinite(r) && r>0) app.rayonKm = r;
    } else {
      app.rayonKm = Number(pv);
      $('rayonPerso').value = '';
    }
    redrawCircle(); refreshRayonKPI();
  };
  $('rayonPreset').addEventListener('change', applyRayon);
  $('rayonPerso').addEventListener('change', applyRayon);

  // Réseau
  $('reseau').addEventListener('change', e=>{ app.reseau = e.target.value; });

  // Actions
  $('btnRecentrer').onclick = ()=> app.map.setView([app.centre.lat, app.centre.lon], 13);
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
    const { out, errors } = parseParticipantsCSV(text);
    if(errors.length) showError(`${errors.length} erreur(s) d’import:\n- ${errors.join('\n- ')}`);
    out.forEach(addParticipant);
  };
  $('btnExportCsv').onclick = exportCSV;

  // Storage
  $('btnSaveLocal').onclick = saveProject;
  $('btnLoadLocal').onclick = ()=>{
    const payload = loadProject(); if(!payload) return showError('Aucun projet sauvegardé');
    const s = payload.state || {};
    app.centre = s.centre || app.centre;
    app.rayonKm = s.rayonKm || app.rayonKm;
    app.reseau = s.reseau || app.reseau;
    app.participants = Array.isArray(s.participants) ? s.participants : [];
    $('lat').value = app.centre.lat.toFixed(6); $('lon').value = app.centre.lon.toFixed(6);
    $('rayonPreset').value = [2,10,20].includes(Number(app.rayonKm)) ? String(app.rayonKm) : 'perso';
    if($('rayonPreset').value==='perso') $('rayonPerso').value = app.rayonKm;
    $('reseau').value = app.reseau;
    app.layers.centrale.setLatLng([app.centre.lat, app.centre.lon]); redrawCircle();
    renderParticipantsList(); drawParticipants(); refreshAll();
    setStatus('Projet chargé (local)');
  };
  $('btnDeleteLocal').onclick = ()=> deleteProject();
}

// ---------- Refresh global ----------
function refreshAll(){
  refreshCommune();
  refreshRayonKPI();
}

// ---------- Bootstrap ----------
(async function init(){
  try{
    setStatus('Initialisation…');
    setupMap(); wireUI(); drawParticipants(); refreshAll();
    setStatus('Prêt');
  }catch(e){
    showError(`Init KO: ${e.message}`); setStatus('Erreur (voir détails)');
  }
})();
