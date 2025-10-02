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

// Géocodage BAN
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

// ================== État app ==================
const STORAGE_NS = 'echome-acc-v3';
const STORAGE_LAST = `${STORAGE_NS}:lastProjectId`;
const projectKey = (id) => `${STORAGE_NS}:project:${id}`;
const newId = () => (crypto?.randomUUID?.() || String(Date.now()));

const app = {
  __BUILD__: '2025-10-02T12:00Z',
  map:null, projectId:null, projectName:'',
  distMaxKm:2,
  producteur:null,
  participants:[],
  ui:{ showMEC:false, showFeasible:false, clickAdds:true },
  candidats:[], candIndex:new Map(),
  layers:{
    part:L.layerGroup(), cand:L.layerGroup(), feasible:L.layerGroup(),
    mecHalo:null,mecEdge:null, worstLine:null,worstLabel:null, producer:null
  }
};

// ================== Carte ==================
function setupMap(){
  app.map = L.map('map', { zoomControl:true }).setView([45.191,5.684],12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{ attribution:'© OSM' }).addTo(app.map);
  L.control.scale({ position:'topleft', imperial:false, maxWidth:160 }).addTo(app.map);

  app.layers.part.addTo(app.map); app.layers.cand.addTo(app.map); app.layers.feasible.addTo(app.map);

  // clic carte = consommateur si activé, ALT-clic = producteur
  app.map.on('click', (e)=>{
    if (e.originalEvent && e.originalEvent.altKey) { setProducteur({lat:e.latlng.lat, lon:e.latlng.lng},{doReverse:true}); return; }
    if (!app.ui.clickAdds) return;
    const nom=`Consommateur ${app.participants.length+1}`;
    addParticipant({id:crypto.randomUUID(), nom, lat:e.latlng.lat, lon:e.latlng.lng, type:'consumer'});
  });

  enableLongPressProducer(); // mobile long press = producteur

  // confort tactile
  app.map.scrollWheelZoom.disable(); app.map.touchZoom.enable(); app.map.doubleClickZoom.enable();
}

// long press mobile = producteur
function enableLongPressProducer(){
  let pressTimer=null, started=false;
  app.map.on('touchstart', (e)=>{
    if(pressTimer) clearTimeout(pressTimer);
    started=true;
    pressTimer=setTimeout(async ()=>{
      if(!started) return;
      const t=e.touches?.[0]; if(!t) return;
      const pt=app.map.mouseEventToLatLng({ clientX:t.clientX, clientY:t.clientY, target:app.map._container });
      setProducteur({lat:pt.lat, lon:pt.lng},{doReverse:true});
      setStatus('Producteur défini (pression longue)');
    },650);
  },{passive:true});
  app.map.on('touchend', ()=>{started=false;if(pressTimer)clearTimeout(pressTimer);});
}

// ================== Producteur & Participants ==================
function setProducteur({lat,lon},opts={}){
  app.producteur={lat,lon};
  $('prodLat').value=lat.toFixed(6); $('prodLon').value=lon.toFixed(6);

  if(!app.layers.producer){
    app.layers.producer=L.marker([lat,lon],{
      title:'Producteur', draggable:true,
      icon:L.divIcon({className:'prod-icon',html:'<div class="pin"></div>',iconSize:[20,20],iconAnchor:[10,20]})
    }).addTo(app.map);
    app.layers.producer.on('dragend',async()=>{
      const {lat:la,lng:lo}=app.layers.producer.getLatLng();
      setProducteur({lat:la,lon:lo},{doReverse:true});
    });
  } else { app.layers.producer.setLatLng([lat,lon]); }

  (async()=>{ if(opts.doReverse && $('addrFull')){ const label=await reverseBAN(lat,lon); if(label) $('addrFull').value=label; } })();
  afterModelChange();
}
function clearProducteur(){
  app.producteur=null;
  if(app.layers.producer){ app.map.removeLayer(app.layers.producer); app.layers.producer=null; }
  if($('addrFull')) $('addrFull').value='';
  afterModelChange();
}
function addParticipant(p){ app.participants.push(p); afterModelChange(); }
function removeParticipant(id){ app.participants=app.participants.filter(x=>x.id!==id); afterModelChange(); }
function redrawParticipants(){
  app.layers.part.clearLayers();
  app.participants.forEach(p=>{
    const color=p.type==='producer'?'#f5b841':'#4ea2ff';
    L.circleMarker([p.lat,p.lon],{radius:6,color,weight:2,fillOpacity:.7})
      .bindPopup(`<b>${p.nom}</b><br>${p.type}<br>${p.lat.toFixed(5)},${p.lon.toFixed(5)}`)
      .addTo(app.layers.part);
  });
  $('kpiPart').textContent=app.participants.length;
}
function renderParticipantsList(){
  const wrap=$('listParts'); if(!wrap) return; wrap.innerHTML='';
  app.participants.forEach(p=>{
    const div=document.createElement('div'); div.className='part';
    div.innerHTML=`<div><div><b>${p.nom}</b> — ${p.type}</div><div class="meta">${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}</div></div><div><button data-id="${p.id}" class="danger">Supprimer</button></div>`;
    div.querySelector('button').onclick=(e)=>removeParticipant(e.currentTarget.getAttribute('data-id'));
    wrap.appendChild(div);
  });
}
function afterModelChange(){ redrawParticipants(); renderParticipantsList(); updateComplianceKPI(); drawMEC(); drawFeasibleZone(); saveProject(); }

// ================== Conformité ==================
function worstPair(points){ let worst={d:0,a:null,b:null}; for(let i=0;i<points.length;i++){for(let j=i+1;j<points.length;j++){const d=distKm(points[i],points[j]);if(d>worst.d)worst={d,a:points[i],b:points[j]};}} return worst; }
function updateComplianceKPI(){
  const pts=[]; if(app.producteur)pts.push(app.producteur); app.participants.forEach(p=>pts.push(p));
  if(pts.length<2){$('kpiWorst').textContent='—';$('kpiLegal').textContent='—';clearWorstOverlay();return;}
  const w=worstPair(pts); const ok=(w.d<=app.distMaxKm);
  $('kpiWorst').textContent=`${w.d.toFixed(2)} km / ≤ ${app.distMaxKm} km`;
  $('kpiLegal').textContent=ok?'Conforme ✔︎':'Non conforme ✖︎';
  showWorstOverlay(w,ok);
}
function clearWorstOverlay(){ if(app.layers.worstLine){app.map.removeLayer(app.layers.worstLine);app.layers.worstLine=null;} if(app.layers.worstLabel){app.map.removeLayer(app.layers.worstLabel);app.layers.worstLabel=null;} }
function showWorstOverlay(w,ok){
  clearWorstOverlay();
  app.layers.worstLine=L.polyline([[w.a.lat,w.a.lon],[w.b.lat,w.b.lon]],{color:ok?'#2ecc71':'#e67e22',weight:4,opacity:.9}).addTo(app.map);
  const mid={lat:(w.a.lat+w.b.lat)/2,lon:(w.a.lon+w.b.lon)/2};
  app.layers.worstLabel=L.marker([mid.lat,mid.lon],{icon:L.divIcon({className:'maxpair-label',html:`${w.d.toFixed(2)} km / ≤ ${app.distMaxKm} km`})}).addTo(app.map);
}

// ================== Visuels optionnels ==================
function minimalEnclosingCircle(points){ if(points.length===0) return null; const c=points.reduce((a,p)=>({lat:a.lat+p.lat,lon:a.lon+p.lon}),{lat:0,lon:0}); c.lat/=points.length;c.lon/=points.length; let r=0; points.forEach(p=>{r=Math.max(r,distKm(p,c));}); return {center:c,radiusKm:r}; }
function drawMEC(){
  if(app.layers.mecHalo){app.map.removeLayer(app.layers.mecHalo);app.layers.mecHalo=null;}
  if(app.layers.mecEdge){app.map.removeLayer(app.layers.mecEdge);app.layers.mecEdge=null;}
  if(!app.ui.showMEC) return;
  const pts=[]; if(app.producteur)pts.push(app.producteur); app.participants.forEach(p=>pts.push(p));
  if(pts.length<1) return; const mec=minimalEnclosingCircle(pts); if(!mec) return; const r=mec.radiusKm*1000;
  app.layers.mecHalo=L.circle([mec.center.lat,mec.center.lon],{radius:r,color:'#00ffd0',opacity:0.18,weight:12,fill:false}).addTo(app.map);
  app.layers.mecEdge=L.circle([mec.center.lat,mec.center.lon],{radius:r,color:'#7A6AFB',weight:3,opacity:0.95,dashArray:'8,6',fillOpacity:.06,fillColor:'#7A6AFB'}).addTo(app.map);
}
function drawFeasibleZone(){
  app.layers.feasible.clearLayers(); if(!app.ui.showFeasible)return;
  const pts=[]; if(app.producteur)pts.push(app.producteur); app.participants.forEach(p=>pts.push(p));
  if(pts.length===0)return; const r=app.distMaxKm/2;
  pts.forEach(p=>{L.circle([p.lat,p.lon],{radius:r*1000,color:'#37C3AF',weight:1,opacity:0.5,fillOpacity:0.08,fillColor:'#37C3AF'}).addTo(app.layers.feasible);});
}

// ================== Prospection (Overpass) ==================
const OVERPASS_URL='https://overpass-api.de/api/interpreter';
async function overpass(query){ try{const body=new URLSearchParams({data:query}).toString(); return await fetchJSON(OVERPASS_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8'},body,timeoutMs:20000,retries:2,expect:'json'});}catch(e){showError(`Overpass KO: ${e.message}`);return null;} }
function normalizeOSM(elements){ const out=[];(elements||[]).forEach(e=>{const lat=e.lat??e.center?.lat,lon=e.lon??e.center?.lon;if(Number.isFinite(lat)&&Number.isFinite(lon)){out.push({id:`osm-${e.type}-${e.id}`,nom:e.tags?.name||e.tags?.ref||'—',lat,lon,raw:e.tags||{}});}}); return out; }
function labelFromTags(tags){const cat=tags.amenity||tags.shop||tags.leisure||tags.landuse||tags.building||'';const lut={school:'École',college:'Collège',university:'Université',hospital:'Hôpital',clinic:'Clinique',doctors:'Médecins',pharmacy:'Pharmacie',sports_centre:'Centre sportif',stadium:'Stade',pitch:'Terrain',swimming_pool:'Piscine',marketplace:'Marché',supermarket:'Supermarché',parking:'Parking',industrial:'Industriel'};return lut[cat]||cat||'Établissement';}
function buildProspectPopup(c){
  const D=app.distMaxKm; const dprod=app.producteur?distKm(c,app.producteur):null; const dmaxIf=dMaxIfAdded(c); const admissible=dmaxIf<=D;
  const name=c.nom||'—'; const cat=labelFromTags(c.raw||{}); const addr=c.raw?.['addr:full']||(c.raw?.['addr:housenumber']&&c.raw?.['addr:street']?`${c.raw['addr:housenumber']||''} ${c.raw['addr:street']||''}`.trim():(c.raw?.['addr:city']||'—'));
  return `<div class="pp"><div><b>${name}</b></div><div class="muted small">${cat}</div><div class="muted small">${addr}</div><hr><div class="muted small">↔ Prod: <b>${dprod!==null?dprod.toFixed(2)+' km':'—'}</b></div><div class="muted small">Pire paire si ajouté: <b>${dmaxIf.toFixed(2)} km</b> (≤ ${D} km)</div><div>${admissible?'<span style="color:#2ecc71">✅ Admissible</span>':'<span style="color:#cc2b4a">❌ Hors périmètre</span>'}</div><div style="display:flex;gap:.35rem;margin-top:.35rem"><button class="primary" data-act="cand-add" data-id="${c.id}">Ajouter</button><button data-act="cand-sim" data-id="${c.id}">Simuler</button><button class="ghost" data-act="cand-zoom" data-id="${c.id}">Zoom</button><button class="ghost" data-act="cand-open" data-id="${c.id}">Fiche</button></div></div>`;
}
function overpassQueryAroundProducer(Dkm,cats){ if(!app.producteur){showError('Définis producteur');return null;} const r=Math.max(1,Math.round(Dkm*1000)); const {lat,lon}=app.producteur; const b=[]; if(cats.has('education'))b.push(`node(around:${r},${lat},${lon})["amenity"~"school|college|university"];`); if(cats.has('sante'))b.push(`node(around:${r},${lat},${lon})["amenity"~"clinic|hospital|doctors|pharmacy"];`); if(cats.has('adm'))b.push(`node(around:${r},${lat},${lon})["amenity"~"townhall|public_building|library"];`); if(cats.has('sport'))b.push(`node(around:${r},${lat},