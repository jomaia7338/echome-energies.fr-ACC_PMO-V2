/* app.js — ACC V2 (Leaflet)
   - Périmètre D/2 (2/10/20/perso) + centre libre (MEC)
   - Participants Prod/Cons
   - POI SDIS/SIS/STIS/SLIS Isère (Overpass) sans doublons
   - Entreprises EPCI Annuaire (sans clé) + export CSV
   - Exports CSV/GeoJSON
*/

(function(){
  // ---------- Utils ----------
  const $ = sel => document.querySelector(sel);
  const $all = sel => Array.from(document.querySelectorAll(sel));
  const setText = (el, txt) => { if(el){ el.textContent = txt; } };
  const setHTML = (el, html) => { if(el){ el.innerHTML = html; } };

  function toRad(d){ return d * Math.PI/180; }
  function haversineKm(a,b){
    const R=6371, dLat=toRad(b.lat-a.lat), dLon=toRad(b.lng-a.lng);
    const lat1=toRad(a.lat), lat2=toRad(b.lat);
    const h=Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
    return 2*R*Math.asin(Math.sqrt(h));
  }
  function niceNum(x, n=2){ return (x==null||isNaN(x))?'':Number(x).toFixed(n); }

  // Minimal Enclosing Circle (local projection)
  function projectLocal(pointsLL){
    const lat0=pointsLL.reduce((s,p)=>s+p.lat,0)/pointsLL.length;
    const lon0=pointsLL.reduce((s,p)=>s+p.lng,0)/pointsLL.length;
    const P=pointsLL.map(p=>({x:(p.lng-lon0)*111.32*Math.cos(lat0*Math.PI/180), y:(p.lat-lat0)*111.32}));
    return {lat0,lon0,P};
  }
  function unprojectLocal(lat0,lon0,x,y){ return {lat:lat0 + y/111.32, lng: lon0 + x/(111.32*Math.cos(lat0*Math.PI/180))}; }
  function dist2(a,b){ const dx=a.x-b.x, dy=a.y-b.y; return dx*dx+dy*dy; }
  function circleBy2(a,b){ return {x:(a.x+b.x)/2,y:(a.y+b.y)/2,r:Math.sqrt(dist2(a,b))/2}; }
  function circleBy3(a,b,c){
    const A=b.x-a.x, B=b.y-a.y, C=c.x-a.x, D=c.y-a.y;
    const E=A*(a.x+b.x)+B*(a.y+b.y), F=C*(a.x+c.x)+D*(a.y+c.y), G=2*(A*(c.y-b.y)-B*(c.x-b.x));
    if(Math.abs(G)<1e-12) return null;
    const x=(D*E-B*F)/G, y=(A*F-C*E)/G, r=Math.hypot(x-a.x,y-a.y);
    return {x,y,r};
  }
  function inCircle(c,p){ return Math.hypot(c.x-p.x,c.y-p.y) <= c.r + 1e-9; }
  function minimalEnclosingCircle(pointsLL){
    if(pointsLL.length===0) return null;
    if(pointsLL.length===1) return {center:pointsLL[0], r:0};
    const {lat0,lon0,P}=projectLocal(pointsLL);
    let best=null;
    for(let i=0;i<P.length;i++) for(let j=i+1;j<P.length;j++){
      const c=circleBy2(P[i],P[j]); if(P.every(p=>inCircle(c,p))) if(!best||c.r<best.r) best=c;
    }
    for(let i=0;i<P.length;i++) for(let j=i+1;j<P.length;j++) for(let k=j+1;k<P.length;k++){
      const c=circleBy3(P[i],P[j],P[k]); if(!c) continue;
      if(P.every(p=>inCircle(c,p))) if(!best||c.r<best.r) best=c;
    }
    if(!best){
      let max=-1,a=-1,b=-1;
      for(let i=0;i<P.length;i++) for(let j=i+1;j<P.length;j++){ const d=dist2(P[i],P[j]); if(d>max){max=d;a=i;b=j;} }
      best=circleBy2(P[a],P[b]);
    }
    const center=unprojectLocal(lat0,lon0,best.x,best.y);
    return {center, r:best.r};
  }

  // ---------- State ----------
  const statusEl = $('#status');
  const colors = { producer:'#6D28D9', consumer:'#2e86de', poi:'#E10600' };
  const eps = 1e-9;

  const participants = []; // {id,name,type,lat,lng,marker}
  const pois = [];         // {id,name,kind,lat,lng,marker}
  let enterprises = [];    // normalized rows for CSV (Annuaire)
  let uid = 0;

  let vizCircle = null;    // Leaflet circle (radius meters) — purely visual
  let circleCenter = null; // {lat,lng} centre libre (pour calculs et POI in-range)
  let circleRadiusKm = 0;

  // ---------- Map ----------
  const map = L.map('map', { zoomControl: true }).setView([45.3, 5.6], 9);

  // OSM France (comme MonEnergieCollective)
  const osmfr = L.tileLayer('https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap France',
    crossOrigin: true
  });
  // fallback osm.org
  const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
    maxZoom: 19,
    attribution:'© OpenStreetMap',
    crossOrigin: true
  });
  osmfr.on('tileerror', ()=>{ if(!map.hasLayer(osm)) osm.addTo(map); if(map.hasLayer(osmfr)) map.removeLayer(osmfr); setText(statusEl,'Fond OSM France indisponible → fallback OSM.'); });
  osmfr.addTo(map);

  // Leaflet scale (m/km)
  L.control.scale({imperial:false, metric:true, maxWidth:120}).addTo(map);

  // Échelle 1:n (approx)
  const RatioControl = L.Control.extend({
    options:{position:'topright'},
    onAdd:function(m){
      const div=L.DomUtil.create('div','leaflet-control ratio-control');
      this._div=div; this._map=m; this._update=this._update.bind(this);
      m.on('zoomend moveend', this._update); this._update(); return div;
    },
    onRemove:function(m){ m.off('zoomend moveend', this._update); },
    _update:function(){
      const c=this._map.getCenter(), z=this._map.getZoom();
      if(z==null){ this._div.textContent='Échelle —'; return; }
      const mpp=156543.03392 * Math.cos(c.lat*Math.PI/180) / Math.pow(2,z);
      const denom=Math.max(1, Math.round(mpp / 0.0002645833333));
      this._div.textContent='Échelle ~ 1:'+denom.toLocaleString('fr-FR');
    }
  });
  map.whenReady(()=> map.addControl(new RatioControl()));

  // Layers
  const participantLayer = L.layerGroup().addTo(map);
  const poiLayer = L.layerGroup().addTo(map);

  // Layout map height
  const mapEl = $('#map');
  function layout(){
    const H=$('header.slim');
    const h=Math.max(420, window.innerHeight - (H?H.getBoundingClientRect().height:0) - 16);
    if(mapEl){ mapEl.style.height = h+'px'; map.invalidateSize(); }
  }
  window.addEventListener('resize', layout);
  setTimeout(layout, 50);

  // ---------- UI helpers ----------
  function selectedType(){
    const r = document.querySelector('input[name="ptype"]:checked');
    return r ? r.value : 'consumer';
  }
  function currentDiameter(){
    const sel = $('#limitSel');
    if(!sel) return 20;
    const v = sel.value;
    if(v==='custom'){
      const k = parseFloat($('#customKm')?.value || '0');
      return (!isFinite(k)||k<=0)?20:k;
    }
    return parseFloat(v||'20');
  }
  function updateCount(){
    const c=$('#count');
    if(!c) return;
    const n=participants.length, np=participants.filter(p=>p.type==='producer').length;
    c.textContent = n? `${n} point${n>1?'s':''} dont ${np} producteur${np>1?'s':''}.` : 'Aucun point.';
  }

  // ---------- Participants ----------
  function makeParticipantPopup(entry){
    const wrap=document.createElement('div');
    const title=document.createElement('strong'); title.textContent=entry.name||''; wrap.appendChild(title);
    wrap.appendChild(document.createElement('br'));
    wrap.appendChild(document.createTextNode(entry.type));
    const box=document.createElement('div'); box.style.marginTop='6px'; box.style.display='flex'; box.style.gap='6px'; box.style.flexWrap='wrap';
    const bRen=document.createElement('button'); bRen.className='btn secondary'; bRen.textContent='Renommer';
    bRen.onclick=()=>{ const nn=prompt('Nouveau nom :', entry.name||''); if(nn&&nn.trim()){ entry.name=nn.trim(); entry.marker.setPopupContent(makeParticipantPopup(entry)); entry.marker.bindTooltip(`${entry.name} (${entry.type})`);} };
    const bDel=document.createElement('button'); bDel.className='btn secondary'; bDel.textContent='Supprimer';
    bDel.onclick=()=> removeParticipant(entry.id);
    box.appendChild(bRen); box.appendChild(bDel); wrap.appendChild(box);
    return wrap;
  }
  function addParticipant(lat,lng,type,name){
    const id=++uid, label=name||`${type} ${id}`;
    const m=L.circleMarker([lat,lng],{radius:7,color:colors[type]||'#333',weight:2,fillColor:colors[type]||'#333',fillOpacity:0.3}).addTo(participantLayer);
    const entry={id,name:label,type,lat,lng,marker:m};
    m.bindTooltip(`${label} (${type})`);
    m.bindPopup(makeParticipantPopup(entry));
    m.on('contextmenu', ()=> removeParticipant(id)); // clic long mobile = menu contextuel aussi
    participants.push(entry);
    refreshACC(false); // ne pas auto-fit sur ajout ponctuel
  }
  function removeParticipant(id){
    const i=participants.findIndex(p=>p.id===id);
    if(i>-1){ participantLayer.removeLayer(participants[i].marker); participants.splice(i,1); refreshACC(false); }
  }
  map.on('click', e=> addParticipant(e.latlng.lat, e.latlng.lng, selectedType()));

  // ---------- ACC (diameter/2) ----------
  function clearVizCircle(){
    if(vizCircle){ map.removeLayer(vizCircle); vizCircle=null; }
    circleCenter=null; circleRadiusKm=0;
  }
  function styleParticipants(center, R){
    participants.forEach(p=>{
      const inside = haversineKm(center,{lat:p.lat,lng:p.lng}) <= R + eps;
      p.marker.setStyle({
        color: inside ? colors[p.type] : '#8b8b8b',
        weight: inside ? 3 : 2,
        fillColor: colors[p.type],
        fillOpacity: inside ? 0.5 : 0.15
      });
    });
  }
  function refreshACC(autoFitBounds=true){
    updateCount();
    const D=currentDiameter(); const R=D/2;
    clearVizCircle();

    if(!participants.length){
      setText(statusEl,'Ajoutez un producteur et des consommateurs.'); updatePoiInRange(null,null); return;
    }
    if(!participants.some(p=>p.type==='producer')){
      setText(statusEl,'Aucun producteur détecté.'); updatePoiInRange(null,null); return;
    }
    const mec = minimalEnclosingCircle(participants.map(p=>({lat:p.lat,lng:p.lng})));
    if(!mec){ setText(statusEl,'Centre libre non calculable.'); updatePoiInRange(null,null); return; }

    const pass = mec.r <= R + eps;
    vizCircle = L.circle([mec.center.lat,mec.center.lng],{
      radius:R*1000, color:'#6D28D9', weight:2, fill:false, opacity:0.9, dashArray:'6 6'
    }).addTo(map).bindTooltip('Centre libre (visualisation) — centre non défini',{className:'center-free-tip'});

    circleCenter = {lat:mec.center.lat, lng:mec.center.lng};
    circleRadiusKm = R;

    styleParticipants(circleCenter, R);

    if(autoFitBounds && participants.length>1){
      const g=L.featureGroup(participants.map(p=>p.marker));
      map.fitBounds(g.getBounds().pad(0.25));
    }

    const outside = participants.filter(p=> haversineKm(circleCenter,{lat:p.lat,lng:p.lng}) > R + eps).map(p=> p.name||p.type);
    if(pass){
      setHTML(statusEl, `<strong>Conforme</strong> — D=${D} km · r*=${niceNum(mec.r)} km ≤ D/2=${niceNum(R)} km.`, 'ok');
      statusEl.className='ok';
    }else{
      setHTML(statusEl, `<strong>Non conforme</strong> — D=${D} km · r*=${niceNum(mec.r)} km > D/2=${niceNum(R)} km · Points limitants : ${outside.join(', ')||'—'}`, 'ko');
      statusEl.className='ko';
    }

    // Juste info visuelle
    updatePoiInRange(circleCenter, R);
  }

  // ---------- POI SDIS Isère ----------
  let poiLoadedOnce = false; // évite cumul
  function addPOI(lat,lng,kind,name){
    const id=++uid, label=name||kind||'POI';
    const m=L.circleMarker([lat,lng],{radius:6,color:colors.poi,weight:2,fillColor:colors.poi,fillOpacity:0.25}).addTo(poiLayer);
    const entry={id,name:label,kind,lat,lng,marker:m};
    m.bindTooltip(`${label} — ${kind||'incendie'}`);
    pois.push(entry);
  }
  function updatePoiInRange(center, R){
    const poiInRangeEl = $('#poiInRange');
    if(!poiInRangeEl) return;
    if(!center || R==null){ setText(poiInRangeEl,'0'); return; }
    let cnt=0;
    pois.forEach(p=>{
      const inside = haversineKm(center,{lat:p.lat,lng:p.lng}) <= R + eps;
      if(inside) cnt++;
      // Style léger pour feedback
      p.marker.setStyle({
        color: inside ? colors.poi : '#8b8b8b',
        weight: inside ? 4 : 2,
        fillColor: colors.poi,
        fillOpacity: inside ? 0.55 : 0.15
      });
    });
    setText(poiInRangeEl, String(cnt));
  }
  function kindFromTags(tags){
    const t=(s)=>String(s||'').toUpperCase();
    const name=t(tags.name), op=t(tags.operator);
    if(/SDMIS/.test(name)||/SDMIS/.test(op)) return 'SDMIS';
    if(/STIS/.test(name)||/STIS/.test(op)) return 'STIS';
    if(/SLIS/.test(name)||/SLIS/.test(op)) return 'SLIS';
    if(/SDIS/.test(name)||/SDIS/.test(op)) return 'SDIS';
    return 'Caserne';
  }
  function parseOverpassAndAdd(j, seen){
    const els=Array.isArray(j.elements)?j.elements:[];
    let ok=0;
    for(const el of els){
      let lat=null,lng=null;
      if(el.type==='node'){ lat=el.lat; lng=el.lon; }
      else if(el.center){ lat=el.center.lat; lng=el.center.lon; }
      if(lat==null || lng==null) continue;
      const tags=el.tags||{};
      const label=tags.name || tags['addr:place'] || tags['addr:city'] || 'Caserne';
      const key=`${(label||'').toLowerCase()}|${lat.toFixed(5)}|${lng.toFixed(5)}`;
      if(seen.has(key)) continue; seen.add(key);
      addPOI(lat,lng, kindFromTags(tags), label); ok++;
    }
    return ok;
  }
  async function loadPoiIsere(){
    const btn=$('#loadPoiIsere'); if(btn){ btn.disabled=true; }
    const prev = btn?btn.textContent:'';
    if(btn) btn.textContent='Chargement…';

    // Si déjà chargé, on nettoie avant de recharger (pas de cumul)
    if(poiLoadedOnce){
      pois.splice(0).forEach(p=> poiLayer.removeLayer(p.marker));
      setText($('#poiStats'),'0');
    }

    const queries = [
`[out:json][timeout:60];
(
  rel["admin_level"="6"]["ref:INSEE"="38"];
  rel["admin_level"="6"]["name"="Isère"];
  rel["admin_level"="6"]["name"="Isere"];
); map_to_area->.a;
(
  node["amenity"="fire_station"](area.a);
  way["amenity"="fire_station"](area.a);
  relation["amenity"="fire_station"](area.a);
); out center tags;`,
`[out:json][timeout:60];
(
  node["amenity"="fire_station"](45.00,5.10,45.80,6.45);
  way["amenity"="fire_station"](45.00,5.10,45.80,6.45);
  relation["amenity"="fire_station"](45.00,5.10,45.80,6.45);
); out center tags;`
    ];
    const endpoints=[
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
      'https://lz4.overpass-api.de/api/interpreter'
    ];

    let success=false; const seen=new Set();
    try{
      for(const q of queries){
        if(success) break;
        for(const ep of endpoints){
          try{
            const r=await fetch(ep+'?data='+encodeURIComponent(q),{headers:{'Accept':'application/json'}});
            if(!r.ok) throw new Error('HTTP '+r.status);
            const j=await r.json();
            const k=parseOverpassAndAdd(j, seen);
            if(k>0){ success=true; break; }
          }catch(e){ /* endpoint suivant */ }
        }
      }
      if(success){
        poiLoadedOnce = true;
        setText(statusEl,'POI Isère chargés.');
      } else {
        setText(statusEl,'Aucun POI trouvé (aire/bbox). Vérifie le réseau.');
      }
    }finally{
      const stats = $('#poiStats');
      if(stats) setText(stats, String(pois.length));
      if(btn){ btn.disabled=false; btn.textContent=prev||'Charger POI Isère'; }
    }
    // MàJ in-range si un périmètre est visible
    if(circleCenter && circleRadiusKm) updatePoiInRange(circleCenter, circleRadiusKm);
  }

  // ---------- Annuaire Entreprises (EPCI) ----------
  const EPCI_CODE = '243801024'; // CC du Massif du Vercors
  async function fetchEpciPage(epciCode, page=1, perPage=100){
    const url = `https://recherche-entreprises.api.gouv.fr/search?epci=${encodeURIComponent(epciCode)}&etat=active&per_page=${perPage}&page=${page}`;
    const r = await fetch(url, { headers: { 'Accept': 'application/json' }});
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }
  function normalizeEnterprise(e){
    const siege = e.siege || {};
    const coords = siege.coordonnees || {};
    return {
      siren: e.siren || '',
      siret: siege.siret || e.siret || '',
      nom_complet: e.nom_complet || e.nom_raison_sociale || '',
      naf: e.naf || e.activite_principale || '',
      libelle_naf: e.libelle_naf || e.libelle_activite_principale || '',
      date_creation: e.date_creation || '',
      etat: e.etat_administratif || e.etat || '',
      categorie: e.categorie_entreprise || '',
      tranche_effectif: e.tranche_effectif_salarie || '',
      adresse: siege.adresse || e.adresse || '',
      code_postal: siege.code_postal || e.code_postal || '',
      commune: siege.commune || e.commune || '',
      epci: siege.epci || e.epci || '',
      lat: (coords.lat ?? e.latitude ?? ''),
      lon: (coords.lon ?? e.longitude ?? '')
    };
  }
  function exportCSV(filename, rows, header){
    if(!rows || !rows.length) return;
    const esc = v => `"${String(v??'').replace(/"/g,'""')}"`;
    const csv = [header.join(";"),
      ...rows.map(r=> header.map(h=>esc(r[h])).join(";"))
    ].join("\n");
    const blob = new Blob([csv],{type:"text/csv;charset=utf-8"});
    const url = URL.createObjectURL(blob);
    const a=document.createElement('a'); a.href=url; a.download=filename; a.click();
    URL.revokeObjectURL(url);
  }
  function exportGeoJSON(filename, features){
    const fc = { type:'FeatureCollection', features };
    const blob = new Blob([JSON.stringify(fc,null,2)],{type:'application/geo+json'});
    const url = URL.createObjectURL(blob);
    const a=document.createElement('a'); a.href=url; a.download=filename; a.click();
    URL.revokeObjectURL(url);
  }

  // ---------- Exports helpers ----------
  function exportParticipantsCSV(){
    const header = ["id","name","type","lat","lng"];
    const rows = participants.map(p=>({id:p.id,name:p.name,type:p.type,lat:p.lat,lng:p.lng}));
    exportCSV('participants.csv', rows, header);
  }
  function exportPoiCSV(){
    const header = ["id","name","kind","lat","lng"];
    const rows = pois.map(p=>({id:p.id,name:p.name,kind:p.kind,lat:p.lat,lng:p.lng}));
    exportCSV('poi_sdis.csv', rows, header);
  }
  function exportParticipantsGeo(){
    const feats = participants.map(p=>({
      type:'Feature',
      properties:{ id:p.id, name:p.name, type:p.type },
      geometry:{ type:'Point', coordinates:[p.lng, p.lat] }
    }));
    exportGeoJSON('participants.geojson', feats);
  }
  function exportPoiGeo(){
    const feats = pois.map(p=>({
      type:'Feature',
      properties:{ id:p.id, name:p.name, kind:p.kind },
      geometry:{ type:'Point', coordinates:[p.lng, p.lat] }
    }));
    exportGeoJSON('poi_sdis.geojson', feats);
  }
  function exportPerimeterGeo(){
    if(!circleCenter || !circleRadiusKm){ setText(statusEl,'Aucun périmètre à exporter.'); return; }
    // cercle en GeoJSON (approx 128 segments)
    const n=128, coords=[];
    const Rkm = circleRadiusKm;
    for(let i=0;i<=n;i++){
      const ang = (i/n)*2*Math.PI;
      const dx = (Rkm/111.32) * Math.cos(ang);
      const dy = (Rkm/111.32) * Math.sin(ang);
      const lat = circleCenter.lat + dy;
      const lng = circleCenter.lng + dx / Math.cos(circleCenter.lat*Math.PI/180);
      coords.push([lng, lat]);
    }
    const feat = {
      type:'Feature',
      properties:{ name:`ACC D=${(2*Rkm).toFixed(2)}km`, radius_km:Rkm, center:[circleCenter.lng,circleCenter.lat] },
      geometry:{ type:'Polygon', coordinates:[coords] }
    };
    exportGeoJSON('perimetre_acc.geojson', [feat]);
  }

  // ---------- Buttons / Events (defensive binding) ----------
  const fitBtn = $('#fitBtn');
  if(fitBtn) fitBtn.addEventListener('click', ()=>{
    if(participants.length){
      const g=L.featureGroup(participants.map(p=>p.marker));
      map.fitBounds(g.getBounds().pad(0.25));
    }
  });

  const clearBtn = $('#clearBtn');
  if(clearBtn) clearBtn.addEventListener('click', ()=>{
    participants.splice(0).forEach(p=> participantLayer.removeLayer(p.marker));
    clearVizCircle();
    setText(statusEl,'Participants effacés.');
    updateCount();
  });

  const locateBtn = $('#locateBtn');
  if(locateBtn) locateBtn.addEventListener('click', ()=>{
    if(!navigator.geolocation){ setText(statusEl,'Géolocalisation non supportée.'); return; }
    navigator.geolocation.getCurrentPosition(pos=>{
      const lat=pos.coords.latitude, lng=pos.coords.longitude, acc=pos.coords.accuracy||50;
      const icon=L.divIcon({className:'myloc-pin', html:`<svg width="28" height="28" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><path d="M16 2C10.477 2 6 6.477 6 12c0 7 10 18 10 18s10-11 10-18C26 6.477 21.523 2 16 2z" fill="#111827"/><circle cx="16" cy="12" r="5" fill="#34D399"/></svg>`, iconSize:[28,28], iconAnchor:[14,28], popupAnchor:[0,-28]});
      L.marker([lat,lng],{icon, zIndexOffset:1000}).addTo(map).bindTooltip('Vous êtes ici');
      L.circle([lat,lng],{radius:acc,color:'#34D399',weight:1,opacity:0.5,fillOpacity:0.06}).addTo(map);
      map.setView([lat,lng], 15);
      setText(statusEl,`Localisé (~±${Math.round(acc)} m).`);
    }, ()=> setText(statusEl,'Géolocalisation refusée / indisponible.'), {enableHighAccuracy:true, timeout:8000, maximumAge:30000});
  });

  const limitSel = $('#limitSel');
  if(limitSel) limitSel.addEventListener('change', (e)=>{
    const v=e.target.value; const custom=$('#customKm');
    if(custom) custom.style.display=(v==='custom')?'inline-block':'none';
    refreshACC(false);
  });
  const customKm = $('#customKm');
  if(customKm) customKm.addEventListener('input', ()=> refreshACC(false));

  const loadPoiBtn = $('#loadPoiIsere');
  if(loadPoiBtn) loadPoiBtn.addEventListener('click', loadPoiIsere);

  const togglePoi = $('#togglePoi');
  if(togglePoi) togglePoi.addEventListener('change', (e)=>{
    if(e.target.checked){ poiLayer.addTo(map); }
    else { map.removeLayer(poiLayer); }
  });

  // Entreprises
  const epciFetchBtn = $('#epciFetchBtn');
  const epciCsvBtn = $('#epciCsvBtn');
  const epciCountEl = $('#epciCount');
  const epciPagesEl = $('#epciPages');

  if(epciFetchBtn){
    epciFetchBtn.addEventListener('click', async ()=>{
      let page=1, total=0; const PER=100;
      enterprises = [];
      if(epciCsvBtn) epciCsvBtn.disabled = true;
      epciFetchBtn.disabled = true; const prev=epciFetchBtn.textContent; epciFetchBtn.textContent='Chargement…';
      try{
        while(true){
          const data = await fetchEpciPage(EPCI_CODE, page, PER);
          const list = Array.isArray(data.results)?data.results:[];
          if(!list.length) break;
          enterprises.push(...list.map(normalizeEnterprise));
          total += list.length;
          if(epciCountEl) setText(epciCountEl, String(total));
          if(epciPagesEl) setText(epciPagesEl, String(page));
          page++;
          await new Promise(r=>setTimeout(r,120)); // souffle
        }
        setText(statusEl, total ? `Entreprises chargées : ${total}.` : `Aucun résultat pour l’EPCI ${EPCI_CODE}.`);
        if(epciCsvBtn) epciCsvBtn.disabled = total===0;
      }catch(e){
        setText(statusEl, 'Erreur EPCI : '+(e.message||e));
      }finally{
        epciFetchBtn.disabled=false; epciFetchBtn.textContent=prev||'Lister entreprises de l’EPCI 243801024';
      }
    });
  }
  if(epciCsvBtn){
    epciCsvBtn.addEventListener('click', ()=>{
      const header = ["siren","siret","nom_complet","naf","libelle_naf","date_creation","etat","categorie","tranche_effectif","adresse","code_postal","commune","epci","lat","lon"];
      exportCSV('entreprises_epci_243801024.csv', enterprises, header);
    });
  }

  // Exports locaux
  const expCsvParticipantsBtn = $('#expCsvParticipantsBtn');
  if(expCsvParticipantsBtn) expCsvParticipantsBtn.addEventListener('click', exportParticipantsCSV);

  const expCsvPoiBtn = $('#expCsvPoiBtn');
  if(expCsvPoiBtn) expCsvPoiBtn.addEventListener('click', exportPoiCSV);

  const expGeoParticipantsBtn = $('#expGeoParticipantsBtn');
  if(expGeoParticipantsBtn) expGeoParticipantsBtn.addEventListener('click', exportParticipantsGeo);

  const expGeoPoiBtn = $('#expGeoPoiBtn');
  if(expGeoPoiBtn) expGeoPoiBtn.addEventListener('click', exportPoiGeo);

  const expGeoPerimeterBtn = $('#expGeoPerimeterBtn');
  if(expGeoPerimeterBtn) expGeoPerimeterBtn.addEventListener('click', exportPerimeterGeo);

  // Impression (si bouton présent)
  const printBtn = $('#printBtn');
  if(printBtn){
    const ensureTilesReady = async (timeout=2000)=>{
      return new Promise(resolve=>{
        const start=Date.now(); const tiles=[...document.querySelectorAll('.leaflet-tile')];
        if(tiles.length===0){ resolve(); return; }
        let remaining=tiles.length;
        const done=()=>{ if(--remaining<=0 || (Date.now()-start)>timeout) resolve(); };
        tiles.forEach(img=>{
          if(img.complete && img.naturalWidth>0){ done(); }
          else { img.addEventListener('load',done,{once:true}); img.addEventListener('error',done,{once:true}); }
        });
        setTimeout(resolve, timeout);
      });
    };
    printBtn.addEventListener('click', async ()=>{
      try{ map.invalidateSize(); }catch(_){}
      await ensureTilesReady(2000);
      window.print();
    });
    window.addEventListener('beforeprint', async ()=>{ try{ map.invalidateSize(); }catch(_){} });
    window.addEventListener('afterprint', ()=>{ setTimeout(()=>{ try{ map.invalidateSize(); }catch(_){} }, 100); });
  }

  // ---------- Ready ----------
  setText(statusEl,'Prêt. Cliquez sur la carte pour ajouter des participants. Cochez le type (Prod/Cons) puis ajustez D (km).');

  // Si tu veux initialiser un producteur par défaut, décommente :
  // addParticipant(45.073, 5.55, 'producer', 'Producteur — défaut');
})();