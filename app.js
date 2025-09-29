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
// Géocodage adresse → lat/lon (BAN)
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
const pointDansRayon = (centre, pt, rayonKm) => haversineMeters(centre, pt) <= (rayonKm*1000)+1;

// ========= État appli / Projets =========
const STORAGE_NS = 'echome-acc-terrain';           // namespace
const STORAGE_LAST = `${STORAGE_NS}:lastProjectId`; // dernier projet ouvert
const app = {
  projectId: null,
  map:null, centre:{ lat:45.191, lon:5.684 }, rayonKm:2, reseau:'BT',
  projectName: '',
  addrLabel: '',
  layers:{ centrale:null, cercle:null, cand:L.layerGroup(), part:L.layerGroup(), sis:L.layerGroup() },
  candidats:[], participants:[]
};
const projectKey = (id) => `${STORAGE_NS}:project:${id}`;
const newId = () => (crypto?.randomUUID?.() || String(Date.now()));

// Charger par lien ?project=<id> sinon dernier projet
function detectStartupProjectId(){
  const p = new URLSearchParams(location.search).get('project');
  if(p) return p;
  try { return localStorage.getItem(STORAGE_LAST) || null; } catch { return null; }
}

// ========= Carte =========
function setupMap(){
  app.map = L.map('map', { zoomControl:true }).setView([app.centre.lat, app.centre.lon], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution:'© OSM' }).addTo(app.map);

  app.layers.centrale = L.marker([app.centre.lat, app.centre.lon], { draggable:true, title:'Centrale' }).addTo(app.map);
  app.layers.centrale.on('dragend', ()=>{
    const { lat, lng } = app.layers.centrale.getLatLng();
    app.centre = { lat, lon: lng };
    $('lat').value = lat.toFixed(6); $('lon').value = lng.toFixed(6);
    redrawCircle(); refreshAll();
  });

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

// ========= Participants =========
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

// ========= Candidats Overpass =========
function overpassQueryCandidats({ lat, lon, rayonKm, cats }){
  const r = Math.max(1, Math.round(rayonKm*1000)); // m
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

// ========= POI SIS =========
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
    out center;`;
}
async function loadSIS(){
  setStatus('Chargement SIS…');
  const q = overpassSISQuery({ lat:app.centre.lat, lon:app.centre.lon, rayonKm:app.rayonKm });
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
  getCommuneParCoord(app.centre.lat, app.centre.lon).then(c=>{
    if(c) $('communePill').textContent = `Commune: ${c.nom}${c.epci?.nom ? ' — EPCI: '+c.epci.nom : ''}`;
  });
}
function refreshRayonKPI(){
  const n = app.participants.filter(p=> pointDansRayon(app.centre, {lat:p.lat, lon:p.lon}, app.rayonKm)).length;
  $('kpiRayon').textContent = n;
}

// ========= CSV =========
function parseParticipantsCSV(text){
  const rows = text.trim().split(/\r?\n/), out=[], errors=[];
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
  if(errors.length) showError(`${errors.length} erreur(s) d’import:\n- ${errors.join('\n- ')}`);
  return out;
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

// ========= Storage / Projets =========
function getCurrentProjectPayload(){
  return {
    __v:1,
    savedAt:new Date().toISOString(),
    state:{
      projectName: app.projectName,
      addrLabel: app.addrLabel,
      centre: app.centre,
      rayonKm: app.rayonKm,
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
    // Met à jour l’URL (deep-link)
    const url = new URL(location.href);
    url.searchParams.set('project', app.projectId);
    history.replaceState(null, '', url.toString());
  }catch(e){ showError(`Sauvegarde KO: ${e.message}`); }
}
function loadProjectById(id){
  try{
    const raw = localStorage.getItem(projectKey(id));
    if(!raw) return null;
    const payload = JSON.parse(raw);
    return payload;
  }catch(e){ showError('Projet corrompu'); return null; }
}
function applyProjectPayload(payload){
  const s = payload?.state || {};
  app.projectName = s.projectName || '';
  app.addrLabel = s.addrLabel || '';
  app.centre = s.centre || app.centre;
  app.rayonKm = s.rayonKm || app.rayonKm;
  app.reseau = s.reseau || app.reseau;
  app.participants = Array.isArray(s.participants) ? s.participants : [];
  // UI
  $('projectName').value = app.projectName;
  $('addr').value = app.addrLabel;
  $('lat').value = app.centre.lat.toFixed(6); $('lon').value = app.centre.lon.toFixed(6);
  $('rayonPreset').value = [2,10,20].includes(Number(app.rayonKm)) ? String(app.rayonKm) : 'perso';
  if($('rayonPreset').value==='perso') $('rayonPerso').value = app.rayonKm;
  $('reseau').value = app.reseau;
  app.layers.centrale.setLatLng([app.centre.lat, app.centre.lon]); redrawCircle();
  renderParticipantsList(); drawParticipants(); refreshAll();
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

// ========= Wiring UI =========
function wireUI(){
  // Champs base
  $('lat').value = app.centre.lat.toFixed(6);
  $('lon').value = app.centre.lon.toFixed(6);

  $('lat').addEventListener('change', e=>{ const v=Number(e.target.value); if(Number.isFinite(v)){ app.centre.lat=v; app.layers.centrale.setLatLng([app.centre.lat, app.centre.lon]); redrawCircle(); refreshAll(); saveProject(); }});
  $('lon').addEventListener('change', e=>{ const v=Number(e.target.value); if(Number.isFinite(v)){ app.centre.lon=v; app.layers.centrale.setLatLng([app.centre.lat, app.centre.lon]); redrawCircle(); refreshAll(); saveProject(); }});

  // Rayon
  const applyRayon = ()=>{
    const pv = $('rayonPreset').value;
    if(pv==='perso'){
      const r = Number($('rayonPerso').value);
      if(Number.isFinite(r) && r>0) app.rayonKm = r;
    } else {
      app.rayonKm = Number(pv);
      $('rayonPerso').value = '';
    }
    redrawCircle(); refreshRayonKPI(); saveProject();
  };
  $('rayonPreset').addEventListener('change', applyRayon);
  $('rayonPerso').addEventListener('change', applyRayon);

  // Réseau
  $('reseau').addEventListener('change', e=>{ app.reseau = e.target.value; saveProject(); });

  // Adresse → géocodage
  $('btnGeocode').onclick = async ()=>{
    const q = $('addr').value?.trim();
    if(!q) return showError('Saisir une adresse');
    setStatus('Géocodage…');
    const r = await geocodeAdresse(q);
    if(!r) return setStatus('Géocodage impossible');
    app.addrLabel = r.label;
    app.centre = { lat: r.lat, lon: r.lon };
    $('lat').value = r.lat.toFixed(6); $('lon').value = r.lon.toFixed(6);
    app.layers.centrale.setLatLng([r.lat, r.lon]);
    redrawCircle(); refreshAll(); setStatus('Adresse localisée');
    saveProject();
  };

  // Nom du dossier
  $('projectName').addEventListener('input', (e)=>{ app.projectName = e.target.value; saveProject(); });

  // Actions carte
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
    saveProject();
  };
  $('btnImportCsv').onclick = async ()=>{
    const f = $('fileCsv').files?.[0];
    if(!f) return showError('Aucun fichier CSV sélectionné');
    const text = await f.text();
    const arr = parseParticipantsCSV(text);
    arr.forEach(addParticipant);
    saveProject();
  };
  $('btnExportCsv').onclick = exportCSV;

  // Stockage
  $('btnSaveLocal').onclick = ()=> saveProject(true);
  $('btnLoadLocal').onclick = ()=>{
    const id = app.projectId || localStorage.getItem(STORAGE_LAST);
    if(!id) return showError('Aucun projet à charger');
    const payload = loadProjectById(id);
    if(!payload) return showError('Projet introuvable');
    applyProjectPayload(payload);
  };
  $('btnDeleteLocal').onclick = ()=> deleteProject();

  // Lien direct
  $('btnCopyLink').onclick = ()=>{
    if(!app.projectId) saveProject();
    const url = new URL(location.href);
    url.searchParams.set('project', app.projectId);
    copyToClipboard(url.toString());
  };
}

// ========= Refresh global =========
function refreshAll(){
  refreshCommune();
  refreshRayonKPI();
  // Sauvegarde implicite à chaque mouvement central
}

// ========= Bootstrap =========
(async function init(){
  try{
    setStatus('Initialisation…');
    // Détecte projet à ouvrir
    const candidateId = detectStartupProjectId();
    if(candidateId){
      const payload = loadProjectById(candidateId);
      if(payload){
        app.projectId = candidateId;
        // Initialise carte d’abord pour pouvoir placer le marqueur
        setupMap(); wireUI(); applyProjectPayload(payload);
        localStorage.setItem(STORAGE_LAST, app.projectId);
        // normalise URL (garde le project id)
        const url = new URL(location.href);
        url.searchParams.set('project', app.projectId);
        history.replaceState(null, '', url.toString());
        setStatus('Projet chargé');
        return;
      }
    }
    // Nouveau projet (vierge)
    app.projectId = newId();
    setupMap(); wireUI(); drawParticipants(); refreshAll();
    saveProject(); // crée l’entrée + lastProject
    setStatus('Prêt');
  }catch(e){
    showError(`Init KO: ${e.message}`); setStatus('Erreur (voir détails)');
  }
})();
