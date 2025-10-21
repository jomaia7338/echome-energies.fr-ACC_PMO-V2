// ================== Helpers ==================
const $ = (id) => document.getElementById(id);
const setStatus = (m) => { const el = $('status'); if (el) el.textContent = m; };
const showError = (m) => {
  const box = $('error-box'); if(!box) return;
  box.classList.remove('hidden');
  box.textContent += `[${new Date().toLocaleTimeString()}] ${m}\n`;
  box.scrollTop = box.scrollHeight;
  console.error(m);
};

async function fetchJSON(url, { method='GET', body, headers={}, timeoutMs=15000, retries=1, expect='auto' } = {}){
  const ctrl = new AbortController(); const t = setTimeout(()=>ctrl.abort(), timeoutMs);
  try{
    const res = await fetch(url, { method, body, headers, signal: ctrl.signal, cache:'no-store' });
    if(!res.ok){ const txt = await res.text().catch(()=> ''); throw new Error(`HTTP ${res.status} ${url} :: ${txt.slice(0,160)}`); }
    const ct = res.headers.get('content-type') || '';
    if(expect==='text') return await res.text();
    if(expect==='json' || ct.includes('application/json')) return await res.json();
    const raw = await res.text(); try{ return JSON.parse(raw); }catch{ return raw; }
  }catch(e){
    if(retries>0){ await new Promise(r=>setTimeout(r, 600)); return fetchJSON(url,{method,body,headers,timeoutMs:timeoutMs*1.5,retries:retries-1,expect}); }
    throw e;
  }finally{ clearTimeout(t); }
}

// BAN
async function geocodeAdresse(q){
  const url = `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(q)}&limit=1`;
  try{
    const json = await fetchJSON(url, { timeoutMs:10000, retries:1, expect:'json' });
    const feat = json?.features?.[0]; if(!feat) throw new Error('Adresse introuvable');
    const [lon, lat] = feat.geometry.coordinates; const label = feat.properties?.label || q;
    return { lat, lon, label };
  }catch(e){ showError(`Géocodage KO: ${e.message}`); return null; }
}
async function reverseBAN(lat, lon){
  const url = `https://api-adresse.data.gouv.fr/reverse/?lat=${lat}&lon=${lon}`;
  try{
    const j = await fetchJSON(url, { timeoutMs:10000, retries:1, expect:'json' });
    const feat = j?.features?.[0];
    return feat?.properties?.label || null;
  }catch{ return null; }
}

// Géodésie
function haversineMeters(a,b){
  const R=6371000, toRad=d=>d*Math.PI/180;
  const dLat=toRad(b.lat-a.lat), dLon=toRad(b.lon-a.lon);
  const lat1=toRad(a.lat), lat2=toRad(b.lat);
  const h=Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(h));
}
const distKm = (a,b)=>haversineMeters(a,b)/1000;

// Validation coordonnées
function isValidLatLon(lat, lon){
  return Number.isFinite(lat) && Number.isFinite(lon)
    && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
    && !(lat === 0 && lon === 0);
}

// ================== App state ==================
const STORAGE_NS = 'echome-acc-v15';
const STORAGE_LAST = `${STORAGE_NS}:lastProjectId`;
const projectKey = (id) => `${STORAGE_NS}:project:${id}`;
const newId = () => (crypto?.randomUUID?.() || String(Date.now()));

const app = {
  __BUILD__: '2025-10-21',
  map:null,
  projectId:null,

  distMaxKm: 2,         // D = 2/10/20
  producteur: null,     // {lat, lon}
  participants: [],     // [{id, nom, lat, lon, type}]

  // modes 1-tap
  mode: null,           // 'set-producer' | 'add-part' | null

  // Overlays & couches
  layers:{
    producer: null,
    parts: L.layerGroup(),
    worstLine: null, worstLabel: null,

    // Boucle ACC centrée libre (déplaçable)
    accCircle: null,      // L.circle (rayon = D/2)
    accCenter: null       // L.marker draggable (centre libre)
  }
};

// ================== Map ==================
function setupMap(){
  app.map = L.map('map', { zoomControl:true }).setView([45.191, 5.684], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{ attribution:'© OSM' }).addTo(app.map);
  L.control.scale({ position:'topleft', imperial:false, maxWidth:160 }).addTo(app.map);
  app.layers.parts.addTo(app.map);

  // Clic (modes)
  app.map.on('click', (e)=>{
    if(app.mode === 'set-producer'){
      setProducer({ lat:e.latlng.lat, lon:e.latlng.lng }, { reverse:true });
      setStatus('Producteur défini'); app.mode = null; highlightMode();
    } else if(app.mode === 'add-part'){
      const nom = `Consommateur ${app.participants.length+1}`;
      addParticipant({ id:newId(), nom, lat:e.latlng.lat, lon:e.latlng.lng, type:'consumer' });
      setStatus('Participant ajouté'); app.mode = null; highlightMode();
    }
  });

  // Appui long carte = ajouter un consommateur (terrain)
  enableLongPressAddOnMap();

  // Confort tactile
  app.map.scrollWheelZoom.disable();
  app.map.touchZoom.enable();
  app.map.doubleClickZoom.enable();

  // Instancie la boucle ACC (centre libre) au 1er affichage
  ensureAccCircle();
}

// Appui long carte → ajoute un consommateur
function enableLongPressAddOnMap(){
  let t=null, started=false, startPt=null;
  app.map.on('touchstart', (e)=>{
    started = true;
    const t0 = e.touches?.[0]; if(!t0) return;
    startPt = { x:t0.clientX, y:t0.clientY };
    t = setTimeout(()=>{
      if(!started) return;
      const pt = app.map.mouseEventToLatLng({ clientX:startPt.x, clientY:startPt.y, target: app.map._container });
      const nom = `Consommateur ${app.participants.length+1}`;
      addParticipant({ id:newId(), nom, lat:pt.lat, lon:pt.lng, type:'consumer' });
      setStatus('Participant ajouté (pression longue)');
    }, 650);
  }, { passive:true });
  app.map.on('touchmove', (e)=>{
    const t1 = e.touches?.[0]; if(!t1||!startPt) return;
    if(Math.hypot(t1.clientX-startPt.x, t1.clientY-startPt.y)>12){ started=false; if(t) clearTimeout(t); }
  }, { passive:true });
  app.map.on('touchend', ()=>{ started=false; if(t) clearTimeout(t); });
}

// ================== Sheets ==================
function openSheet(id){ const el=$(id); if(!el) return; el.classList.add('open'); el.setAttribute('aria-hidden','false'); }
function closeSheet(id){ const el=$(id); if(!el) return; el.classList.remove('open'); el.setAttribute('aria-hidden','true'); }

// ================== Producer ==================
function setProducer({lat, lon}, opts={}){
  if(!isValidLatLon(lat, lon)){ showError('Coordonnées producteur invalides'); return; }
  app.producteur = { lat, lon };
  if($('prodLat')) $('prodLat').value = lat.toFixed(6);
  if($('prodLon')) $('prodLon').value = lon.toFixed(6);

  if(!app.layers.producer){
    app.layers.producer = L.marker([lat,lon], {
      draggable:true,
      title:'Producteur',
      icon: L.divIcon({ className:'prod-icon', html:'<div class="pin" style="width:18px;height:18px;border-radius:50%;background:#f5b841;border:2px solid #b58900"></div>', iconSize:[20,20], iconAnchor:[10,20] })
    }).addTo(app.map);
    app.layers.producer.on('dragend', async ()=>{
      const { lat:la, lng:lo } = app.layers.producer.getLatLng();
      setProducer({ lat:la, lon:lo }, { reverse:true });
    });
  } else {
    app.layers.producer.setLatLng([lat,lon]);
  }

  (async ()=>{
    if(opts.reverse && $('addrFull')){
      const label = await reverseBAN(lat, lon); if(label) $('addrFull').value = label;
    }
  })();

  afterModelChange();
}
function clearProducer(){
  app.producteur = null;
  if(app.layers.producer){ app.map.removeLayer(app.layers.producer); app.layers.producer = null; }
  if($('addrFull')) $('addrFull').value = '';
  afterModelChange();
}

// ================== Participants ==================
function bindMarkerDeletion(marker, payload){
  const html = `<div style="min-width:160px">
    <b>${payload.nom || 'Participant'}</b><br>
    ${payload.type || 'consumer'}<br>
    ${payload.lat.toFixed(5)}, ${payload.lon.toFixed(5)}<br>
    <button id="del-${payload.id}" class="btn danger" style="margin-top:6px">Supprimer</button>
  </div>`;
  marker.bindPopup(html);
  marker.on('popupopen', ()=>{
    const btn = document.getElementById(`del-${payload.id}`);
    if(btn) btn.onclick = ()=> { marker.closePopup(); removeParticipant(payload.id); setStatus('Participant supprimé'); };
  });
  let t=null, pressed=false;
  marker.on('touchstart', ()=>{
    pressed=true;
    t=setTimeout(()=>{
      if(!pressed) return;
      if(confirm(`Supprimer "${payload.nom}" ?`)){ removeParticipant(payload.id); setStatus('Participant supprimé'); }
    }, 650);
  });
  marker.on('touchend', ()=>{ pressed=false; if(t) clearTimeout(t); });
}
function addParticipant(p){
  if(!isValidLatLon(p.lat, p.lon)){ showError('Coordonnées participant invalides'); return; }
  app.participants.push(p);
  afterModelChange();
}
function removeParticipant(id){
  app.participants = app.participants.filter(x=>x.id!==id);
  afterModelChange();
}
function redrawParticipants(){
  app.layers.parts.clearLayers();
  app.participants.forEach(p=>{
    const color = p.type==='producer' ? '#f5b841' : '#4ea2ff';
    const marker = L.circleMarker([p.lat,p.lon], { radius:6, color, weight:2, fillOpacity:.75 })
      .addTo(app.layers.parts);
    bindMarkerDeletion(marker, p);
  });
  const wrap = $('listParts'); if(wrap){ wrap.innerHTML='';
    app.participants.forEach(p=>{
      const div = document.createElement('div'); div.className='part';
      div.innerHTML = `<div><div><b>${p.nom}</b> — ${p.type}</div><div class="meta">${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}</div></div><div><button class="btn danger" data-del="${p.id}">Supprimer</button></div>`;
      div.querySelector('[data-del]').onclick = (e)=> removeParticipant(e.currentTarget.getAttribute('data-del'));
      wrap.appendChild(div);
    });
  }
}

// ================== Boucle ACC : cercle centre libre ==================
function ensureAccCircle(){
  const defaultCenter = app.producteur ? [app.producteur.lat, app.producteur.lon] : app.map.getCenter();
  const radiusMeters = (app.distMaxKm/2) * 1000; // D/2

  if(!app.layers.accCircle){
    app.layers.accCircle = L.circle(defaultCenter, {
      radius: radiusMeters,
      color: '#6e5bfd',
      weight: 3, opacity: 1,
      fillOpacity: 0.06, fillColor: '#6e5bfd',
      dashArray: '8,6'
    }).addTo(app.map);
  }else{
    app.layers.accCircle.setLatLng(defaultCenter);
    app.layers.accCircle.setRadius(radiusMeters);
  }

  if(!app.layers.accCenter){
    // marqueur centre (draggable) — centre libre
    app.layers.accCenter = L.marker(defaultCenter, {
      draggable:true,
      title:'Centre de la boucle ACC (déplaçable)',
      icon: L.divIcon({ className:'acc-center', html:'<div style="width:14px;height:14px;border-radius:50%;background:#fff;border:3px solid #6e5bfd;box-shadow:0 0 0 2px rgba(110,91,253,.35)"></div>', iconSize:[14,14], iconAnchor:[7,7] })
    }).addTo(app.map);

    // Drag du centre → déplace le cercle
    app.layers.accCenter.on('drag', ()=>{
      const { lat, lng } = app.layers.accCenter.getLatLng();
      app.layers.accCircle.setLatLng([lat, lng]);
    });
    app.layers.accCenter.on('dragend', ()=> setStatus('Centre de la boucle déplacé'));
  }else{
    app.layers.accCenter.setLatLng(defaultCenter);
  }
}

// Pour mettre à jour le rayon quand on change D
function updateAccCircleRadius(){
  if(!app.layers.accCircle){ ensureAccCircle(); return; }
  const r = (app.distMaxKm/2) * 1000;
  app.layers.accCircle.setRadius(r);
}

// ================== Pire paire (critère juridique) ==================
function worstPair(points){
  let worst={d:0,a:null,b:null};
  for(let i=0;i<points.length;i++){
    for(let j=i+1;j<points.length;j++){
      const d = distKm(points[i], points[j]);
      if(d>worst.d) worst = { d, a:points[i], b:points[j] };
    }
  }
  return worst;
}
function clearWorstOverlay(){
  if(app.layers.worstLine){ app.map.removeLayer(app.layers.worstLine); app.layers.worstLine=null; }
  if(app.layers.worstLabel){ app.map.removeLayer(app.layers.worstLabel); app.layers.worstLabel=null; }
}
function drawWorstOverlay(w, D){
  clearWorstOverlay();
  if(!w?.a || !w?.b) return;
  const ok = w.d <= D;
  app.layers.worstLine = L.polyline([[w.a.lat,w.a.lon],[w.b.lat,w.b.lon]], { color: ok ? '#2ecc71' : '#e67e22', weight:4, opacity:.9 }).addTo(app.map);
  const mid = { lat:(w.a.lat+w.b.lat)/2, lon:(w.a.lon+w.b.lon)/2 };
  app.layers.worstLabel = L.marker([mid.lat, mid.lon], { icon: L.divIcon({ className:'maxpair-label', html:`${w.d.toFixed(2)} km / ≤ ${D} km` }) }).addTo(app.map);
}

// ================== Conformité ==================
function updateCompliance(){
  const pts = [];
  if(app.producteur) pts.push({ ...app.producteur, nom:'Producteur', type:'producer' });
  app.participants.forEach(p=>pts.push(p));

  // MAJ cercle (au cas où on vient d’ajouter/supprimer)
  ensureAccCircle();
  updateAccCircleRadius();

  if(pts.length < 2){
    clearWorstOverlay();
    $('badgeCompliance').textContent = '—';
    setStatus(`D = ${app.distMaxKm} km — poser des points`);
    return;
  }
  const w = worstPair(pts);
  const ok = w.d <= app.distMaxKm;
  $('badgeCompliance').textContent = ok ? '✔︎' : '✖︎';
  setStatus(`D = ${app.distMaxKm} km — pire paire ${w.d.toFixed(2)} km`);
  drawWorstOverlay(w, app.distMaxKm);
}

// ================== Persistence ==================
function getPayload(){
  // Sauvegarde aussi le centre libre de la boucle
  const center = app.layers.accCenter ? app.layers.accCenter.getLatLng() : null;
  const accCenter = center ? { lat:center.lat, lon:center.lng } : null;

  return { __v:3, savedAt:new Date().toISOString(), state:{
    distMaxKm: app.distMaxKm,
    producteur: app.producteur,
    participants: app.participants,
    accCenter
  }};
}
function saveProject(){
  try{
    if(!app.projectId) app.projectId = newId();
    localStorage.setItem(projectKey(app.projectId), JSON.stringify(getPayload()));
    localStorage.setItem(STORAGE_LAST, app.projectId);
    const url = new URL(location.href); url.searchParams.set('project', app.projectId); history.replaceState(null,'',url.toString());
  }catch(e){ showError(`Sauvegarde KO: ${e.message}`); }
}
function loadProjectById(id){
  try{ const raw = localStorage.getItem(projectKey(id)); return raw?JSON.parse(raw):null; }
  catch(e){ showError('Projet corrompu'); return null; }
}
function applyPayload(payload){
  const s = payload?.state || {};
  app.distMaxKm = s.distMaxKm ?? 2;
  app.producteur = s.producteur || null;
  app.participants = Array.isArray(s.participants) ? s.participants : [];

  // sync chips
  document.querySelectorAll('#chipDiameter .chip').forEach(b=>{
    const d = Number(b.getAttribute('data-d')); const active = d === app.distMaxKm;
    b.classList.toggle('active', active); b.setAttribute('aria-pressed', active ? 'true':'false');
  });

  // Producteur
  if(app.producteur && isValidLatLon(app.producteur.lat, app.producteur.lon)){
    setProducer(app.producteur, { reverse:true });
    app.map.setView([app.producteur.lat, app.producteur.lon], 13);
  }else{
    clearProducer();
  }

  // Centre boucle ACC (si sauvegardé)
  ensureAccCircle();
  if(s.accCenter && isValidLatLon(s.accCenter.lat, s.accCenter.lon)){
    app.layers.accCenter.setLatLng([s.accCenter.lat, s.accCenter.lon]);
    app.layers.accCircle.setLatLng([s.accCenter.lat, s.accCenter.lon]);
  }
  afterModelChange();
}

// ================== UI wiring ==================
function highlightMode(){
  if(app.mode==='set-producer') setStatus('Mode: poser le producteur (tap)');
  else if(app.mode==='add-part') setStatus('Mode: ajouter un participant (tap)');
  else setStatus('Prêt');
}

function wireSheets(){
  $('btnProducer')?.addEventListener('click', ()=> openSheet('sheetProducer'));
  document.querySelectorAll('[data-close="#sheetProducer"]').forEach(el=> el.addEventListener('click', ()=> closeSheet('sheetProducer')));
  $('btnParticipants')?.addEventListener('click', ()=> openSheet('sheetParticipants'));
  document.querySelectorAll('[data-close="#sheetParticipants"]').forEach(el=> el.addEventListener('click', ()=> closeSheet('sheetParticipants')));
}

function wireProducer(){
  $('btnGeocode')?.addEventListener('click', async ()=>{
    const q = $('addr')?.value?.trim(); if(!q) return showError('Saisir une adresse');
    setStatus('Géocodage…');
    const r = await geocodeAdresse(q); if(!r) return setStatus('Géocodage impossible');
    setProducer({ lat:r.lat, lon:r.lon }); $('addrFull') && ( $('addrFull').value = r.label || q );
    app.map.setView([r.lat, r.lon], 14); setStatus('Adresse localisée');
  });
  $('btnLocate')?.addEventListener('click', ()=>{
    if(!navigator.geolocation) return showError('Géolocalisation non supportée');
    setStatus('Géolocalisation…');
    navigator.geolocation.getCurrentPosition(async pos=>{
      const { latitude, longitude } = pos.coords;
      setProducer({ lat: latitude, lon: longitude }, { reverse:true });
      app.map.setView([latitude, longitude], 15);
      setStatus('Position GPS acquise');
    }, err=>{
      showError(`GPS KO: ${err.message||'inconnu'}`); setStatus('Géolocalisation indisponible');
    }, { enableHighAccuracy:true, timeout:10000, maximumAge:0 });
  });
  $('btnTapSetProducer')?.addEventListener('click', ()=>{ app.mode = 'set-producer'; closeSheet('sheetProducer'); highlightMode(); });
  $('btnSetProducerFromInputs')?.addEventListener('click', ()=>{
    const la = Number($('prodLat')?.value), lo = Number($('prodLon')?.value);
    if(!isValidLatLon(la, lo)) return showError('Coordonnées producteur invalides');
    setProducer({ lat:la, lon:lo }, { reverse:true }); app.map.setView([la, lo], 14);
    setStatus('Producteur défini (coord.)');
  });
  $('btnClearProducer')?.addEventListener('click', ()=> { clearProducer(); setStatus('Producteur supprimé'); });
}

function wireParticipants(){
  $('btnAddPart')?.addEventListener('click', ()=>{
    const nom = $('partNom')?.value?.trim() || `Consommateur ${app.participants.length+1}`;
    const la = Number($('partLat')?.value), lo = Number($('partLon')?.value);
    const type = ($('partType')?.value || 'consumer').toLowerCase();
    if(!isValidLatLon(la, lo)) return showError('Coordonnées invalides');
    addParticipant({ id:newId(), nom, lat:la, lon:lo, type });
    $('partNom').value=''; $('partLat').value=''; $('partLon').value='';
    setStatus('Participant ajouté');
  });
  $('btnAddOnMap')?.addEventListener('click', ()=>{ app.mode='add-part'; closeSheet('sheetParticipants'); highlightMode(); });
  $('btnImportCsv')?.addEventListener('click', async ()=>{
    const f = $('fileCsv')?.files?.[0]; if(!f) return showError('Aucun fichier CSV');
    const text = await f.text(); const rows = text.trim().split(/\r?\n/); const out=[];
    const startIdx = rows[0]?.toLowerCase().includes('nom;') ? 1 : 0;
    for(let i=startIdx;i<rows.length;i++){
      const [nom, lat, lon, typeRaw] = rows[i].split(';').map(s=>s?.trim());
      const la=Number(lat), lo=Number(lon), type=(typeRaw||'consumer').toLowerCase();
      if(nom && isValidLatLon(la, lo)) out.push({ id:newId(), nom, lat:la, lon:lo, type });
    }
    out.forEach(addParticipant);
    setStatus(`Importé ${out.length} participants`);
  });
  $('btnExportCsv')?.addEventListener('click', ()=>{
    const rows = [['Nom','Lat','Lon','Type'], ...app.participants.map(p=>[p.nom,p.lat,p.lon,p.type])];
    const csv = rows.map(r=>r.join(';')).join('\n');
    const blob = new Blob([csv], { type:'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `participants_${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.csv`; a.click();
    URL.revokeObjectURL(a.href);
  });
}

function wireDiameterChips(){
  document.querySelectorAll('#chipDiameter .chip').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.querySelectorAll('#chipDiameter .chip').forEach(b=>{ b.classList.remove('active'); b.setAttribute('aria-pressed','false'); });
      btn.classList.add('active'); btn.setAttribute('aria-pressed','true');
      app.distMaxKm = Number(btn.getAttribute('data-d')) || 2;
      updateAccCircleRadius();
      onProjectChanged();
    });
  });
}

// ================== Reactions ==================
function afterModelChange(){
  redrawParticipants();
  updateCompliance();   // pire paire + MAJ cercle
  saveProject();
}
function onProjectChanged(){
  updateCompliance();
  saveProject();
}

// ================== Bootstrap ==================
(function init(){
  try{
    setStatus('Initialisation…');
    setupMap();
    wireSheets();
    wireProducer();
    wireParticipants();
    wireDiameterChips();

    const fromUrl = new URLSearchParams(location.search).get('project')
                 || localStorage.getItem(STORAGE_LAST);
    if(fromUrl){
      const payload = loadProjectById(fromUrl);
      if(payload){ app.projectId = fromUrl; applyPayload(payload); setStatus('Projet chargé'); return; }
    }
    app.projectId = newId(); saveProject();
    setStatus('Prêt');
  }catch(e){
    showError(`Init KO: ${e.message}`); setStatus('Erreur (voir détails)');
  }
})();
