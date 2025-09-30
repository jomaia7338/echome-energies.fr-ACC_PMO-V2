// ================== Helpers ==================
const $ = (id) => document.getElementById(id);
const setStatus = (m) => { const el = $('status'); if (el) el.textContent = m; };
const showError = (m) => { const box=$('error-box'); if(!box) return; box.classList.remove('hidden'); box.textContent += `[${new Date().toLocaleTimeString()}] ${m}\n`; console.error(m); };

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

// Géodésie
function haversineMeters(a,b){
  const R=6371000, toRad=d=>d*Math.PI/180;
  const dLat=toRad(b.lat-a.lat), dLon=toRad(b.lon-a.lon);
  const lat1=toRad(a.lat), lat2=toRad(b.lat);
  const h=Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(h));
}
const distKm = (a,b)=>haversineMeters(a,b)/1000;

// Réseaux externes
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
async function geocodeAdresse(q){
  const url = `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(q)}&limit=1`;
  try{
    const json = await fetchJSON(url, { timeoutMs:10000, retries:1, expect:'json' });
    const feat = json?.features?.[0]; if(!feat) throw new Error('Adresse introuvable');
    const [lon, lat] = feat.geometry.coordinates; const label = feat.properties?.label || q;
    return { lat, lon, label };
  }catch(e){ showError(`Géocodage KO: ${e.message}`); return null; }
}

const STORAGE_NS = 'echome-acc-v3';
const STORAGE_LAST = `${STORAGE_NS}:lastProjectId`;
const projectKey = (id) => `${STORAGE_NS}:project:${id}`;
const newId = () => (crypto?.randomUUID?.() || String(Date.now()));

// ================== État app ==================
const app = {
  __BUILD__: '2025-09-30T22:30Z',

  map:null,
  projectId: null,
  projectName:'',

  // Métier
  distMaxKm: 2,            // Diamètre D (2/10/20/Perso)
  producteur: null,        // {lat, lon}
  participants: [],        // {id, nom, lat, lon, type}

  // UI
  ui: { showMEC:false, showFeasible:false, clickAdds:true },

  // Candidats
  candidats: [],           // liste normalisée
  candIndex: new Map(),    // id -> objet

  // Couche Leaflet
  layers:{
    part: L.layerGroup(),
    cand: L.layerGroup(),
    feasible: L.layerGroup(),
    mecHalo:null, mecEdge:null,
    worstLine:null, worstLabel:null
  }
};

// ================== Setup carte ==================
function setupMap(){
  app.map = L.map('map', { zoomControl:true }).setView([45.191, 5.684], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{ attribution:'© OSM' }).addTo(app.map);
  L.control.scale({ position:'topleft', imperial:false, maxWidth:160 }).addTo(app.map);

  app.layers.part.addTo(app.map);
  app.layers.cand.addTo(app.map);
  app.layers.feasible.addTo(app.map);

  // CLIC CARTE : option “clickAdds” => ajoute un consommateur rapide
  app.map.on('click', (e)=>{
    if (!app.ui.clickAdds) return; // neutre si décoché
    const nom = `Consommateur ${app.participants.length+1}`;
    addParticipant({ id:crypto.randomUUID(), nom, lat:e.latlng.lat, lon:e.latlng.lng, type:'consumer' });
  });
}

// ================== UI wiring ==================
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

  // FAB mobile
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
  $('projectName')?.addEventListener('input', (e)=>{ app.projectName = e.target.value; saveProject(); });
  $('btnCopyLink')?.addEventListener('click', ()=>{
    if(!app.projectId) saveProject();
    const url = new URL(location.href); url.searchParams.set('project', app.projectId);
    navigator.clipboard.writeText(url.toString()).then(()=> setStatus('Lien copié'));
  });

  // Producteur
  $('btnGeocode')?.addEventListener('click', async ()=>{
    const q = $('addr')?.value?.trim(); if(!q) return showError('Saisir une adresse');
    setStatus('Géocodage…'); const r = await geocodeAdresse(q); if(!r) return setStatus('Géocodage impossible');
    setProducteur({ lat:r.lat, lon:r.lon }); app.map.setView([r.lat, r.lon], 14); setStatus('Adresse localisée');
  });
  $('btnSetProducerFromInputs')?.addEventListener('click', ()=>{
    const la = Number($('prodLat')?.value), lo = Number($('prodLon')?.value);
    if(!Number.isFinite(la)||!Number.isFinite(lo)) return showError('Coordonnées producteur invalides');
    setProducteur({ lat:la, lon:lo }); app.map.setView([la, lo], 14);
  });
  $('btnLocate')?.addEventListener('click', ()=>{
    if(!navigator.geolocation) return showError('Géolocalisation non supportée');
    setStatus('Géolocalisation en cours…');
    navigator.geolocation.getCurrentPosition(pos=>{
      const { latitude, longitude } = pos.coords;
      app.map.setView([latitude, longitude], 15);
      if(!app.producteur){ setProducteur({ lat:latitude, lon:longitude }); }
      setStatus('Position GPS acquise');
    }, err=>{
      showError(`GPS KO: ${err.message||'inconnu'}`); setStatus('Géolocalisation indisponible');
    }, { enableHighAccuracy:true, timeout:10000, maximumAge:0 });
  });
  $('btnClearProducer')?.addEventListener('click', ()=>{ clearProducteur(); });

  // Diamètre (chips)
  document.querySelectorAll('#zoneBtns .seg-btn[data-d]')?.forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.querySelectorAll('#zoneBtns .seg-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      app.distMaxKm = Number(btn.getAttribute('data-d'));
      onProjectChanged();
    });
  });
  $('dPersoBtn')?.addEventListener('click', ()=>{
    document.querySelectorAll('#zoneBtns .seg-btn').forEach(b=>b.classList.remove('active'));
    $('dPersoBtn').classList.add('active');
    const v = Number($('distMaxPerso')?.value); if(Number.isFinite(v)&&v>0){ app.distMaxKm = v; onProjectChanged(); }
  });
  $('distMaxPerso')?.addEventListener('change', (e)=>{
    const v = Number(e.target.value); if(Number.isFinite(v)&&v>0){ app.distMaxKm = v; $('dPersoBtn')?.classList.add('active'); onProjectChanged(); }
  });

  // Clic = ajouter consommateur
  $('toggleClickAdd')?.addEventListener('change', (e)=>{ app.ui.clickAdds = !!e.target.checked; });

  // Toggles visuels
  $('toggleMEC')?.addEventListener('change', (e)=>{ app.ui.showMEC = !!e.target.checked; drawMEC(); });
  $('toggleFeasible')?.addEventListener('change', (e)=>{ app.ui.showFeasible = !!e.target.checked; drawFeasibleZone(); });

  // Prospection
  $('btnScan')?.addEventListener('click', scanProspects);

  // Participants
  $('btnAddPart')?.addEventListener('click', ()=>{
    const nom=$('partNom')?.value?.trim(); const lat=Number($('partLat')?.value), lon=Number($('partLon')?.value);
    const type=$('partType')?.value || 'consumer';
    if(!nom || !Number.isFinite(lat) || !Number.isFinite(lon)) return showError('Participant: champs incomplets');
    addParticipant({ id:crypto.randomUUID(), nom, lat, lon, type });
    $('partNom').value=''; $('partLat').value=''; $('partLon').value='';
  });
  $('btnImportCsv')?.addEventListener('click', async ()=>{
    const f = $('fileCsv')?.files?.[0]; if(!f) return showError('Aucun fichier CSV');
    const text = await f.text(); const rows = text.trim().split(/\r?\n/); const out=[];
    const startIdx = rows[0]?.toLowerCase().includes('nom;') ? 1 : 0;
    for(let i=startIdx;i<rows.length;i++){
      const [nom, lat, lon, typeRaw] = rows[i].split(';').map(s=>s?.trim());
      const la=Number(lat), lo=Number(lon), type=(typeRaw||'consumer').toLowerCase();
      if(nom && Number.isFinite(la) && Number.isFinite(lo)) out.push({ id:crypto.randomUUID(), nom, lat:la, lon:lo, type });
    }
    out.forEach(addParticipant);
  });
  $('btnExportCsv')?.addEventListener('click', ()=>{
    const rows = [['Nom','Lat','Lon','Type'], ...app.participants.map(p=>[p.nom,p.lat,p.lon,p.type])];
    const csv = rows.map(r=>r.join(';')).join('\n');
    const blob = new Blob([csv], { type:'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `participants_${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.csv`; a.click(); URL.revokeObjectURL(a.href);
  });

  // Projet (local)
  $('btnSaveLocal')?.addEventListener('click', ()=> saveProject(true));
  $('btnLoadLocal')?.addEventListener('click', ()=>{
    const id = app.projectId || localStorage.getItem(STORAGE_LAST); if(!id) return showError('Aucun projet à charger');
    const payload = loadProjectById(id); if(!payload) return showError('Projet introuvable'); applyProjectPayload(payload);
  });
  $('btnDeleteLocal')?.addEventListener('click', ()=> deleteProject());
}

// ================== Métier ACC ==================
function worstPair(points){
  let worst = {d:0,a:null,b:null};
  for(let i=0;i<points.length;i++){
    for(let j=i+1;j<points.length;j++){
      const d = distKm(points[i], points[j]);
      if(d > worst.d) worst = {d, a:points[i], b:points[j]};
    }
  }
  return worst;
}
function updateComplianceKPI(){
  const pts=[]; if(app.producteur) pts.push(app.producteur); app.participants.forEach(p=>pts.push(p));
  if(pts.length<2){ $('kpiWorst').textContent='—'; $('kpiLegal').textContent='—'; clearWorstOverlay(); return; }
  const w = worstPair(pts); const ok = (w.d <= app.distMaxKm);
  $('kpiWorst').textContent = `${w.d.toFixed(2)} km / ≤ ${app.distMaxKm} km`;
  $('kpiLegal').textContent = ok ? 'Conforme ✔︎' : 'Non conforme ✖︎';
  showWorstOverlay(w, ok);
}
function clearWorstOverlay(){
  if(app.layers.worstLine){ app.map.removeLayer(app.layers.worstLine); app.layers.worstLine=null; }
  if(app.layers.worstLabel){ app.map.removeLayer(app.layers.worstLabel); app.layers.worstLabel=null; }
}
function showWorstOverlay(w, ok){
  clearWorstOverlay();
  app.layers.worstLine = L.polyline(
    [[w.a.lat,w.a.lon],[w.b.lat,w.b.lon]],
    { color: ok ? '#2ecc71' : '#e67e22', weight:4, opacity:.9 }
  ).addTo(app.map);
  const mid = { lat:(w.a.lat+w.b.lat)/2, lon:(w.a.lon+w.b.lon)/2 };
  app.layers.worstLabel = L.marker([mid.lat,mid.lon], {
    icon: L.divIcon({ className:'maxpair-label', html:`${w.d.toFixed(2)} km / ≤ ${app.distMaxKm} km` })
  }).addTo(app.map);
}

// ================== Visuels optionnels (MEC / faisable) ==================
function minimalEnclosingCircle(points){
  if(points.length===0) return null;
  const c = points.reduce((a,p)=>({lat:a.lat+p.lat, lon:a.lon+p.lon}), {lat:0,lon:0});
  c.lat/=points.length; c.lon/=points.length;
  let r=0; points.forEach(p=>{ r = Math.max(r, distKm(p,c)); });
  return { center:c, radiusKm:r };
}
function drawMEC(){
  if(app.layers.mecHalo){ app.map.removeLayer(app.layers.mecHalo); app.layers.mecHalo=null; }
  if(app.layers.mecEdge){ app.map.removeLayer(app.layers.mecEdge); app.layers.mecEdge=null; }
  if(!app.ui.showMEC) return;

  const pts=[]; if(app.producteur) pts.push(app.producteur); app.participants.forEach(p=>pts.push(p));
  if(pts.length<1) return;
  const mec = minimalEnclosingCircle(pts); if(!mec) return; const r = mec.radiusKm*1000;

  app.layers.mecHalo = L.circle([mec.center.lat, mec.center.lon], {
    radius:r, color:'#00ffd0', opacity:0.18, weight:12, fill:false
  }).addTo(app.map);
  app.layers.mecEdge = L.circle([mec.center.lat, mec.center.lon], {
    radius:r, color:'#7A6AFB', weight:3, opacity:0.95, dashArray:'8,6', fillOpacity:.06, fillColor:'#7A6AFB'
  }).addTo(app.map);
}
function drawFeasibleZone(){
  app.layers.feasible.clearLayers();
  if(!app.ui.showFeasible) return;

  const pts=[]; if(app.producteur) pts.push(app.producteur); app.participants.forEach(p=>pts.push(p));
  if(pts.length===0) return;

  const r = app.distMaxKm/2; // km
  pts.forEach(p=>{
    L.circle([p.lat,p.lon], {
      radius:r*1000, color:'#37C3AF', weight:1, opacity:0.5, fillOpacity:0.08, fillColor:'#37C3AF'
    }).addTo(app.layers.feasible);
  });
}

// ================== Participants ==================
function redrawParticipants(){
  app.layers.part.clearLayers();
  app.participants.forEach(p=>{
    const color = p.type==='producer' ? '#f5b841' : '#4ea2ff';
    L.circleMarker([p.lat,p.lon],{ radius:6, color, weight:2, fillOpacity:.7 })
      .bindPopup(`<b>${p.nom}</b><br>${p.type}<br>${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`)
      .addTo(app.layers.part);
  });
  $('kpiPart').textContent = app.participants.length;
}
function renderParticipantsList(){
  const wrap = $('listParts'); if(!wrap) return; wrap.innerHTML='';
  app.participants.forEach(p=>{
    const div = document.createElement('div'); div.className='part';
    div.innerHTML = `<div><div><b>${p.nom}</b> — ${p.type}</div><div class="meta">${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}</div></div><div><button data-id="${p.id}" class="danger">Supprimer</button></div>`;
    div.querySelector('button').onclick = (e)=> removeParticipant(e.currentTarget.getAttribute('data-id'));
    wrap.appendChild(div);
  });
}
function addParticipant(p){ app.participants.push(p); afterModelChange(); }
function removeParticipant(id){ app.participants = app.participants.filter(x=>x.id!==id); afterModelChange(); }
function setProducteur({lat, lon}){
  app.producteur = { lat, lon };
  $('prodLat').value = lat.toFixed(6); $('prodLon').value = lon.toFixed(6);
  afterModelChange();
}
function clearProducteur(){ app.producteur = null; afterModelChange(); }

function afterModelChange(){
  redrawParticipants(); renderParticipantsList(); updateComplianceKPI(); drawMEC(); drawFeasibleZone(); saveProject();
}

// ================== Prospection ==================
function normalizeOSM(elements){
  const out=[]; (elements||[]).forEach(e=>{
    const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
    if(Number.isFinite(lat) && Number.isFinite(lon)){
      out.push({ id:`osm-${e.type}-${e.id}`, nom:e.tags?.name || e.tags?.ref || '—', lat, lon, raw:e.tags||{} });
    }
  }); return out;
}
function labelFromTags(tags){
  const cat = tags.amenity || tags.shop || tags.leisure || tags.landuse || tags.building || '';
  const lut = {
    school:'École', college:'Collège', university:'Université',
    hospital:'Hôpital', clinic:'Clinique', doctors:'Médecins', pharmacy:'Pharmacie',
    sports_centre:'Centre sportif', stadium:'Stade', pitch:'Terrain', swimming_pool:'Piscine',
    marketplace:'Marché', supermarket:'Supermarché', parking:'Parking', industrial:'Industriel'
  };
  return lut[cat] || cat || 'Établissement';
}
function buildProspectPopup(c){
  const D = app.distMaxKm;
  const dprod = app.producteur ? distKm(c, app.producteur) : null;
  const dmaxIf = dMaxIfAdded(c);
  const admissible = dmaxIf <= D;

  const name = c.nom || '—';
  const cat = labelFromTags(c.raw||{});
  const addr = c.raw?.['addr:full'] || (c.raw?.['addr:housenumber'] && c.raw?.['addr:street']
                ? `${c.raw['addr:housenumber']||''} ${c.raw['addr:street']||''}`.trim()
                : (c.raw?.['addr:city'] || '—'));

  return `
    <div class="pp">
      <div><b>${name}</b></div>
      <div class="muted small">${cat}</div>
      <div class="muted small">${addr}</div>
      <hr style="border:none;border-top:1px solid #20263d;margin:.4rem 0">
      <div class="muted small">↔ Producteur: <b>${dprod!==null?dprod.toFixed(2)+' km':'—'}</b></div>
      <div class="muted small">Pire paire si ajouté: <b>${dmaxIf.toFixed(2)} km</b> (≤ ${D} km)</div>
      <div style="margin:.35rem 0">${admissible?'<span style="color:#2ecc71">✅ Admissible</span>':'<span style="color:#cc2b4a">❌ Hors périmètre</span>'}</div>
      <div style="display:flex;gap:.35rem;margin-top:.35rem">
        <button class="primary" data-act="cand-add" data-id="${c.id}">Ajouter</button>
        <button data-act="cand-sim" data-id="${c.id}">Simuler</button>
        <button class="ghost" data-act="cand-zoom" data-id="${c.id}">Zoom</button>
        <button class="ghost" data-act="cand-open" data-id="${c.id}">Fiche</button>
      </div>
    </div>
  `;
}
function overpassQueryAroundProducer(Dkm, cats){
  if(!app.producteur){ showError('Définis d’abord le producteur'); return null; }
  const r = Math.max(1, Math.round(Dkm*1000));
  const { lat, lon } = app.producteur;
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
function isCandidateAdmissible(cand, D){
  const pts=[]; if(app.producteur) pts.push(app.producteur); app.participants.forEach(p=>pts.push(p));
  if(pts.length===0) return true;
  let worst = 0;
  for(let i=0;i<pts.length;i++){
    worst = Math.max(worst, distKm(cand, pts[i]));
    if(worst > D) return false;
  }
  return true;
}
function dMaxIfAdded(cand){
  const pts=[]; if(app.producteur) pts.push(app.producteur); app.participants.forEach(p=>pts.push(p));
  pts.push(cand);
  return worstPair(pts).d;
}
async function scanProspects(){
  const t0 = performance.now();
  const cats = new Set([...document.querySelectorAll('.cat:checked')].map(i=>i.value));
  if(cats.size===0){ setStatus('Aucune catégorie sélectionnée'); return; }
  if(!app.producteur){ showError('Définis le producteur'); return; }

  const q = overpassQueryAroundProducer(app.distMaxKm, cats); if(!q) return;
  setStatus('Prospection…');
  const data = await overpass(q);
  app.layers.cand.clearLayers(); app.candidats = []; app.candIndex.clear();

  if(data && Array.isArray(data.elements)){
    const norm = normalizeOSM(data.elements);
    norm.forEach(c=>{
      const cObj = { id:c.id, nom:c.nom, lat:c.lat, lon:c.lon, raw:c.raw };
      app.candIndex.set(cObj.id, cObj);
      const ok = isCandidateAdmissible({lat:cObj.lat, lon:cObj.lon}, app.distMaxKm);
      const color = ok ? '#3ad17c' : '#cc2b4a';
      const mk = L.circleMarker([cObj.lat,cObj.lon], { radius:6, color, weight:2, fillOpacity:.7 })
        .addTo(app.layers.cand);
      mk.bindPopup(buildProspectPopup(cObj));
    });
  }
  $('kpiCand').textContent = app.candIndex.size;
  const dt = Math.round(performance.now() - t0);
  setStatus(`Prospection OK (${app.candIndex.size} prospects en ${dt} ms)`);
}

// Actions des boutons dans les popups
document.addEventListener('click', (e)=>{
  const btn = e.target.closest('[data-act]'); if(!btn) return;
  const act = btn.getAttribute('data-act'); const id = btn.getAttribute('data-id');
  const c = app.candIndex.get(id); if(!c) return;

  if(act==='cand-add'){
    addParticipant({ id:crypto.randomUUID(), nom:c.nom||'Prospect', lat:c.lat, lon:c.lon, type:'consumer' });
    app.map.closePopup();
  }
  if(act==='cand-zoom'){
    app.map.setView([c.lat, c.lon], Math.max(app.map.getZoom(), 17));
  }
  if(act==='cand-sim'){
    const pts=[]; if(app.producteur) pts.push(app.producteur); app.participants.forEach(p=>pts.push(p));
    pts.push(c);
    const w = worstPair(pts); const ok = (w.d <= app.distMaxKm);
    showWorstOverlay(w, ok);
  }
  if(act==='cand-open'){ openProspectPanel(c); }
});

// ================== Fiche prospect (panneau) ==================
function fillProspectPanel(c){
  const D = app.distMaxKm;
  const dprod = app.producteur ? distKm(c, app.producteur) : null;
  const dmaxIf = dMaxIfAdded(c);
  const admissible = dmaxIf <= D;

  $('pp-title').textContent = c.nom || 'Prospect';
  $('pp-sub').textContent = `${labelFromTags(c.raw||{})} — ${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}`;

  $('pp-body').innerHTML = `
    <div class="kv"><div class="k">Adresse</div><div class="v">${c.raw?.['addr:full'] || '—'}</div></div>
    <div class="kv"><div class="k">Téléphone</div><div class="v">${c.raw?.phone || c.raw?.['contact:phone'] || '—'}</div></div>
    <div class="kv"><div class="k">Email</div><div class="v">${c.raw?.email || c.raw?.['contact:email'] || '—'}</div></div>
    <div class="kv"><div class="k">Site</div><div class="v">${c.raw?.website || c.raw?.['contact:website'] || '—'}</div></div>
    <div class="kv"><div class="k">Horaires</div><div class="v small">${c.raw?.opening_hours || '—'}</div></div>
    <hr style="border:none;border-top:1px solid #20263d;margin:.4rem 0">
    <div class="kv"><div class="k">↔ Producteur</div><div class="v">${dprod!==null?dprod.toFixed(2)+' km':'—'}</div></div>
    <div class="kv"><div class="k">Pire paire si ajouté</div><div class="v">${dmaxIf.toFixed(2)} km (≤ ${D} km)</div></div>
    <div class="kv"><div class="k">Verdict</div><div class="v">${admissible?'<span style="color:#2ecc71">✅ Admissible</span>':'<span style="color:#cc2b4a">❌ Hors périmètre</span>'}</div></div>
  `;

  $('pp-add').onclick = ()=>{
    addParticipant({ id:crypto.randomUUID(), nom:c.nom||'Prospect', lat:c.lat, lon:c.lon, type:'consumer' });
    closeProspectPanel();
  };
  $('pp-sim').onclick = ()=>{
    const pts=[]; if(app.producteur) pts.push(app.producteur); app.participants.forEach(p=>pts.push(p));
    pts.push(c);
    const w = worstPair(pts); const ok = (w.d <= app.distMaxKm);
    showWorstOverlay(w, ok);
  };
  $('pp-route').onclick = ()=>{
    const url = `https://www.google.com/maps/dir/?api=1&destination=${c.lat},${c.lon}`;
    window.open(url, '_blank');
  };
}
function openProspectPanel(c){ fillProspectPanel(c); $('prospectPanel').classList.add('open'); }
function closeProspectPanel(){ $('prospectPanel').classList.remove('open'); }
$('pp-close')?.addEventListener('click', closeProspectPanel);

// ================== Storage ==================
function getCurrentProjectPayload(){
  return { __v:1, savedAt:new Date().toISOString(), state:{
    projectName: app.projectName, distMaxKm: app.distMaxKm, producteur: app.producteur, participants: app.participants
  }};
}
function saveProject(explicit=false){
  try{
    if(!app.projectId) app.projectId = newId();
    localStorage.setItem(projectKey(app.projectId), JSON.stringify(getCurrentProjectPayload()));
    localStorage.setItem(STORAGE_LAST, app.projectId);
    if (explicit) setStatus('Projet enregistré (local)');
    const url = new URL(location.href); url.searchParams.set('project', app.projectId); history.replaceState(null, '', url.toString());
  }catch(e){ showError(`Sauvegarde KO: ${e.message}`); }
}
function loadProjectById(id){ try{ const raw = localStorage.getItem(projectKey(id)); return raw?JSON.parse(raw):null; }catch(e){ showError('Projet corrompu'); return null; } }
function applyProjectPayload(payload){
  const s = payload?.state || {};
  app.projectName = s.projectName || ''; $('projectName') && ($('projectName').value = app.projectName);
  app.distMaxKm = s.distMaxKm ?? 2;
  app.producteur = s.producteur || null;
  app.participants = Array.isArray(s.participants) ? s.participants : [];
  $('prodLat').value = app.producteur ? app.producteur.lat.toFixed(6) : '';
  $('prodLon').value = app.producteur ? app.producteur.lon.toFixed(6) : '';
  document.querySelectorAll('#zoneBtns .seg-btn').forEach(b=> b.classList.toggle('active', Number(b.getAttribute('data-d'))===app.distMaxKm));
  afterModelChange();
}
function deleteProject(){
  if(!app.projectId) return;
  try{
    localStorage.removeItem(projectKey(app.projectId));
    if(localStorage.getItem(STORAGE_LAST) === app.projectId) localStorage.removeItem(STORAGE_LAST);
    setStatus('Projet supprimé (local)');
  }catch{}
}
function detectStartupProjectId(){
  const p = new URLSearchParams(location.search).get('project');
  if(p) return p; try { return localStorage.getItem(STORAGE_LAST) || null; } catch { return null; }
}

// ================== Bootstrap ==================
(function init(){
  try{
    setStatus('Initialisation…'); setupMap(); wireUI();
    const candidateId = detectStartupProjectId();
    if(candidateId){
      const payload = loadProjectById(candidateId);
      if(payload){
        app.projectId = candidateId; applyProjectPayload(payload);
        localStorage.setItem(STORAGE_LAST, app.projectId);
        const url = new URL(location.href); url.searchParams.set('project', app.projectId); history.replaceState(null,'',url.toString());
        setStatus('Projet chargé'); return;
      }
    }
    app.projectId = newId(); saveProject(); setStatus('Prêt');
  }catch(e){ showError(`Init KO: ${e.message}`); setStatus('Erreur (voir détails)'); }
})();
