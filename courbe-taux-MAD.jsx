import { useState, useEffect, useCallback } from "react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";

/* ═══════════════════════════════════════════════════════════
   DÉTECTION AUTOMATIQUE DU SERVEUR
   - En production (téléphone sur WiFi) : même IP que la page
   - En dev local : localhost:5000
═══════════════════════════════════════════════════════════ */
function getAPIBase() {
  // Si on accède depuis Claude.ai (artifact), on utilise l'IP saisie manuellement
  // Sinon on prend l'hôte courant avec le port 5000
  const host = window.location.hostname;
  if (host === "localhost" || host === "127.0.0.1") {
    return "http://localhost:5000";
  }
  // Depuis un téléphone sur le réseau local, l'IP est dans le storage
  return null; // sera complété par le champ IP
}

const MAT_LABELS = ["1J","1W","2W","1M","2M","3M","6M","1Y","2Y","3Y","4Y","5Y","7Y","10Y","15Y","20Y","25Y","30Y"];
const L_YEARS    = [0, 0.019444,0.041667,0.086111,0.166667,0.25,0.5,1,2,3,4,5,7,10,15,20,25,30];

const DISPLAY = [
  {idx:3,lbl:"1M"},{idx:5,lbl:"3M"},{idx:6,lbl:"6M"},
  {idx:7,lbl:"1A"},{idx:8,lbl:"2A"},{idx:10,lbl:"4A"},
  {idx:11,lbl:"5A"},{idx:12,lbl:"7A"},{idx:13,lbl:"10A"},
  {idx:14,lbl:"15A"},{idx:15,lbl:"20A"},{idx:16,lbl:"25A"},{idx:17,lbl:"30A"},
];

/* ── Helpers date ── */
const todayISO   = () => new Date().toISOString().slice(0,10);
const isWeekend  = (iso) => { const d = new Date(iso+"T12:00:00"); return d.getDay()===0||d.getDay()===6; };
const prevBizDay = (iso) => {
  const d = new Date(iso+"T12:00:00");
  do { d.setDate(d.getDate()-1); } while (d.getDay()===0||d.getDay()===6);
  return d.toISOString().slice(0,10);
};
const fmtFR = (iso) => {
  if (!iso) return "";
  const [y,m,d] = iso.split("-");
  const M = ["jan","fév","mar","avr","mai","jun","jul","aoû","sep","oct","nov","déc"];
  return `${parseInt(d)} ${M[parseInt(m)-1]} ${y}`;
};

/* ── Storage persistant ── */
const KC = "bkam_v5_cache", KL = "bkam_v5_last", KIP = "bkam_v5_ip";
const getCache  = async () => { try { const r = await window.storage.get(KC); return r ? JSON.parse(r.value) : {}; } catch { return {}; } };
const putCache  = async (c) => { try { await window.storage.set(KC, JSON.stringify(c)); } catch {} };
const getLast   = async () => { try { const r = await window.storage.get(KL); return r ? r.value : null; } catch { return null; } };
const putLast   = async (v) => { try { await window.storage.set(KL, v); } catch {} };
const getSavedIP = async () => { try { const r = await window.storage.get(KIP); return r ? r.value : "https://simoalm-bam-api.hf.space"; } catch { return "https://simoalm-bam-api.hf.space"; } };
const saveIP    = async (v) => { try { await window.storage.set(KIP, v); } catch {} };

/* ── Tooltip ── */
function Tip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const curr = payload.find(p => p.dataKey==="taux");
  const prev = payload.find(p => p.dataKey==="prev");
  const bps  = curr?.value!=null && prev?.value!=null ? Math.round((curr.value-prev.value)*10000) : null;
  return (
    <div style={{background:"rgba(4,8,15,.97)",border:"1px solid rgba(0,210,140,.3)",
      borderRadius:10,padding:"12px 16px",boxShadow:"0 8px 28px rgba(0,210,140,.1)"}}>
      <p style={{color:"#00d28c",fontFamily:"monospace",fontSize:13,fontWeight:700,marginBottom:5}}>{label}</p>
      {curr && <p style={{color:"#dde8d8",fontFamily:"monospace",fontSize:12,margin:"2px 0"}}>Actuel : <b>{(curr.value*100).toFixed(3)}%</b></p>}
      {prev && <p style={{color:"rgba(245,166,35,.75)",fontFamily:"monospace",fontSize:12,margin:"2px 0"}}>Veille : {(prev.value*100).toFixed(3)}%</p>}
      {bps!=null && <p style={{color:bps<0?"#00d28c":bps>0?"#ff6b6b":"#888",fontFamily:"monospace",fontSize:11,marginTop:4}}>Δ {bps>0?"+":""}{bps} pb</p>}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   COMPOSANT PRINCIPAL
═══════════════════════════════════════════════════════════ */
export default function CourbeTauxMAD() {
  const [serverIP,   setServerIP]   = useState("https://simoalm-bam-api.hf.space");
  const [serverPort, setServerPort] = useState("");
  const [ipInput,    setIpInput]    = useState("https://simoalm-bam-api.hf.space");
  const [serverOk,   setServerOk]   = useState(null);

  const [selDate,    setSelDate]    = useState(todayISO());
  const [inputDate,  setInputDate]  = useState(todayISO());
  const [tab,        setTab]        = useState("courbe");
  const [showPrev,   setShowPrev]   = useState(true);

  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState("");

  const [data,       setData]       = useState(null);
  const [dataPrev,   setDataPrev]   = useState(null);
  const [prevIso,    setPrevIso]    = useState(null);
  const [lastDate,   setLastDate]   = useState(null);
  const [ready,      setReady]      = useState(false);

  const apiBase = useCallback(() => {
    const ip = serverIP.trim();
    const port = serverPort.trim();

    // Si c'est une URL complète (contient ://), on l'utilise directement
    if (ip.includes("://")) {
      return ip.endsWith("/") ? ip.slice(0, -1) : ip;
    }

    // Sinon, on construit l'URL classique
    if (ip === "localhost" || ip.match(/^\d+\.\d+\.\d+\.\d+$/)) {
      return `http://${ip}:${port || "5000"}`;
    }
    return `https://${ip}`;
  }, [serverIP, serverPort]);

  /* ── init ── */
  useEffect(() => {
    (async () => {
      const [ld, savedIP] = await Promise.all([getLast(), getSavedIP()]);
      if (savedIP) { setServerIP(savedIP); setIpInput(savedIP); }
      if (ld) { setLastDate(ld); setSelDate(ld); setInputDate(ld); }
      setReady(true);
    })();
  }, []);

  /* ── Test connexion serveur ── */
  const checkServer = useCallback(async (ip = serverIP, port = serverPort) => {
    try {
      const base = apiBase();
      const res = await fetch(`${base}/ping`, {
        signal: AbortSignal.timeout(4000)
      });
      const ok = res.ok;
      setServerOk(ok);
      return ok;
    } catch {
      setServerOk(false);
      return false;
    }
  }, [serverIP, serverPort]);

  /* ── Connexion quand IP change ── */
  const handleConnect = async () => {
    const ip = ipInput.trim();
    setServerIP(ip);
    await saveIP(ip);
    const ok = await checkServer(ip, serverPort);
    if (ok) load(selDate, false, ip);
  };

  /* ── Auto-check au démarrage ── */
  useEffect(() => {
    if (ready) checkServer();
  }, [ready]);

  /* ── Charge quand date ou serveur OK ── */
  useEffect(() => {
    if (ready && serverOk) load(selDate);
  }, [selDate, ready, serverOk]);

  /* ── Chargement données ── */
  const load = useCallback(async (iso, force = false, ip = serverIP) => {
    setLoading(true);
    setError("");
    setData(null);
    setDataPrev(null);

    const pIso = prevBizDay(iso);
    setPrevIso(pIso);
    const base = apiBase();
    const cache = await getCache();

    /* Courbe principale */
    let main = force ? null : cache[iso];
    if (!main) {
      try {
        const res = await fetch(`${base}/courbe?date=${iso}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        main = await res.json();
        if (main.found) await putCache({ ...cache, [iso]: main });
      } catch (e) {
        setError(`Impossible de joindre le serveur (${base}). Vérifiez que api.py tourne.`);
        setLoading(false);
        return;
      }
    }

    /* Courbe veille */
    let prev = cache[pIso];
    if (!prev) {
      try {
        const res2 = await fetch(`${base}/courbe?date=${pIso}`);
        if (res2.ok) {
          prev = await res2.json();
          if (prev.found) await putCache({ ...(await getCache()), [pIso]: prev });
        }
      } catch {}
    }

    setData(main);
    setDataPrev(prev || null);
    await putLast(iso);
    setLastDate(iso);
    setLoading(false);
  }, [serverIP, serverPort]);

  /* ── Actions ── */
  const handleLoad = () => {
    const t = isWeekend(inputDate) ? prevBizDay(inputDate) : inputDate;
    setSelDate(t);
    if (t !== inputDate) setInputDate(t);
  };
  const goToday = () => {
    const t = isWeekend(todayISO()) ? prevBizDay(todayISO()) : todayISO();
    setInputDate(t); setSelDate(t);
  };

  /* ── Données calculées ── */
  const rates     = data?.rates     || [];
  const prevRates = dataPrev?.rates || [];
  const rawPts    = data?.raw_points || [];
  const overnight = data?.overnight ?? null;

  const chartData = DISPLAY.map(m => ({
    label: m.lbl,
    taux:  rates[m.idx]     ?? null,
    prev:  prevRates[m.idx] ?? null,
  }));

  const tableData = MAT_LABELS.map((lbl, idx) => {
    const taux = rates[idx]     ?? null;
    const prev = prevRates[idx] ?? null;
    const bps  = taux!=null && prev!=null ? Math.round((taux-prev)*10000) : null;
    return { lbl, taux, prev, bps };
  });

  const validR = rates.filter(v => v!=null);
  const minR   = validR.length ? Math.min(...validR)-0.003 : 0.02;
  const maxR   = validR.length ? Math.max(...validR)+0.003 : 0.045;

  const spreadVal   = rates[7]!=null && rates[16]!=null ? Math.round((rates[16]-rates[7])*10000)+" pb" : "--";
  const avgShortVal = rates[3]!=null && rates[5]!=null && rates[6]!=null ? ((rates[3]+rates[5]+rates[6])/3*100).toFixed(3)+"%" : "--";
  const avgLongVal  = rates[13]!=null && rates[14]!=null && rates[15]!=null ? ((rates[13]+rates[14]+rates[15])/3*100).toFixed(3)+"%" : "--";
  const overnightVal= overnight!=null ? (overnight*100).toFixed(3)+"%" : "--";

  /* ════════════════════════ RENDER ════════════════════════ */
  return (
    <div style={{minHeight:"100vh",background:"#04080f",color:"#dde8d8",
      fontFamily:"'IBM Plex Mono','Courier New',monospace"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;600;700&family=Bebas+Neue&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:3px}::-webkit-scrollbar-thumb{background:#00d28c33;border-radius:4px}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes up{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.2}}
        .up{animation:up .3s ease forwards}
        .spin{animation:spin .9s linear infinite;display:inline-block}
        .btn{cursor:pointer;border:none;font-family:'IBM Plex Mono',monospace;transition:all .15s}
        .btn:hover:not(:disabled){opacity:.8;transform:scale(1.02)}
        .btn:disabled{opacity:.35;cursor:not-allowed}
        input{font-family:'IBM Plex Mono',monospace}
        input[type=date]{color-scheme:dark}
        input[type=date]::-webkit-calendar-picker-indicator{filter:invert(.5) sepia(1) hue-rotate(100deg) saturate(2);cursor:pointer}
        .rh:hover{background:rgba(0,210,140,.04)!important}
      `}</style>

      {/* ══ HEADER ══ */}
      <div style={{background:"linear-gradient(160deg,#080f1e,#0a1830)",
        borderBottom:"1px solid rgba(0,210,140,.14)",padding:"16px 18px 14px"}}>

        {/* Titre */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",
          flexWrap:"wrap",gap:10,marginBottom:12}}>
          <div>
            <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:3}}>
              <div style={{width:7,height:7,borderRadius:"50%",
                background: serverOk===true?"#00d28c":serverOk===false?"#ff6b6b":"#f5a623",
                boxShadow: serverOk===true?"0 0 7px #00d28c":serverOk===false?"0 0 7px #ff6b6b":"0 0 7px #f5a623",
                animation:"pulse 2s infinite"}}/>
              <span style={{fontSize:8,letterSpacing:3,textTransform:"uppercase",
                color: serverOk===true?"#00d28c":serverOk===false?"#ff6b6b":"#f5a623"}}>
                {serverOk===null ? "Connexion en cours…"
                  : serverOk ? `Serveur BAM connecté ✅ (${serverIP}:${serverPort})`
                  : `Serveur hors ligne ❌ (${serverIP}:${serverPort})`}
              </span>
            </div>
            <h1 style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:26,letterSpacing:2.5,
              color:"#fff",lineHeight:1}}>COURBE DES TAUX BDT</h1>
            <p style={{fontSize:8,color:"#1e3a28",letterSpacing:.8,marginTop:3}}>
              SCRAPING BKAM.MA · INTERPOLATION LINÉAIRE TMP.PY · 17 MATURITÉS · 1J → 30A
            </p>
          </div>

          {lastDate && lastDate!==selDate && (
            <div style={{background:"rgba(0,210,140,.06)",border:"1px solid rgba(0,210,140,.18)",
              borderRadius:8,padding:"8px 12px",textAlign:"right"}}>
              <p style={{fontSize:7,color:"#1e3a28",letterSpacing:1,textTransform:"uppercase"}}>🕐 Dernière session</p>
              <p style={{fontSize:13,color:"#00d28c",fontWeight:700}}>{fmtFR(lastDate)}</p>
              <button className="btn"
                onClick={()=>{setInputDate(lastDate);setSelDate(lastDate);}}
                style={{fontSize:8,color:"#00d28c",background:"none",marginTop:2,
                  textDecoration:"underline",padding:0}}>
                Reprendre →
              </button>
            </div>
          )}
        </div>

        {/* ── Bloc connexion serveur ── */}
        <div style={{background:"rgba(0,0,0,.25)",border:"1px solid rgba(255,255,255,.07)",
          borderRadius:10,padding:"10px 14px",marginBottom:12}}>
          <p style={{fontSize:8,color:"#2a4a38",letterSpacing:2,textTransform:"uppercase",marginBottom:7}}>
            🖥️ Adresse du serveur Python (api.py)
          </p>
          <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
            <div style={{display:"flex",alignItems:"center",gap:0,
              background:"rgba(0,210,140,.07)",border:"1px solid rgba(0,210,140,.25)",borderRadius:8}}>
              <span style={{padding:"8px 10px",fontSize:10,color:"#3a6a4a"}}>http://</span>
              <input value={ipInput} onChange={e=>setIpInput(e.target.value)}
                onKeyDown={e=>e.key==="Enter"&&handleConnect()}
                placeholder="192.168.0.187"
                style={{background:"transparent",border:"none",color:"#dde8d8",
                  padding:"8px 4px",fontSize:13,outline:"none",width:140}}/>
              <span style={{padding:"8px 4px",fontSize:10,color:"#3a6a4a"}}>:</span>
              <input value={serverPort} onChange={e=>setServerPort(e.target.value)}
                style={{background:"transparent",border:"none",color:"#dde8d8",
                  padding:"8px 4px",fontSize:13,outline:"none",width:50}}/>
            </div>

            <button className="btn" onClick={handleConnect}
              style={{background:"rgba(0,210,140,.14)",border:"1px solid rgba(0,210,140,.4)",
                color:"#00d28c",padding:"9px 14px",borderRadius:8,fontSize:11,letterSpacing:1}}>
              🔌 CONNECTER
            </button>

            <button className="btn" onClick={()=>checkServer()}
              style={{background:"rgba(100,100,255,.1)",border:"1px solid rgba(100,100,255,.3)",
                color:"#8899ff",padding:"9px 12px",borderRadius:8,fontSize:11}}>
              🔄 TESTER
            </button>

            {serverOk===true && (
              <span style={{fontSize:10,color:"#00d28c"}}>✅ Connecté</span>
            )}
            {serverOk===false && (
              <span style={{fontSize:10,color:"#ff9999"}}>
                ❌ Non joignable — vérifiez que api.py tourne
              </span>
            )}
          </div>
          <p style={{fontSize:8,color:"#1a3020",marginTop:7}}>
            💡 Trouvez votre IP : ouvrez cmd Windows → tapez <b style={{color:"#3a6a4a"}}>ipconfig</b> → cherchez "Adresse IPv4"
          </p>
        </div>

        {/* ── Sélecteur date ── */}
        <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",marginBottom:12}}>
          <div style={{display:"flex",alignItems:"center",gap:6,
            background:"rgba(0,210,140,.08)",border:"1px solid rgba(0,210,140,.28)",
            borderRadius:8,padding:"2px 12px"}}>
            <span style={{fontSize:10,color:"#00d28c"}}>📅</span>
            <input type="date" value={inputDate}
              max={todayISO()} min="2023-03-21"
              onChange={e=>setInputDate(e.target.value)}
              onKeyDown={e=>e.key==="Enter"&&handleLoad()}
              style={{background:"transparent",border:"none",color:"#dde8d8",
                padding:"8px 0",fontSize:13,outline:"none"}}/>
          </div>

          <button className="btn" onClick={handleLoad} disabled={loading||!serverOk}
            style={{background:"rgba(0,210,140,.14)",border:"1px solid rgba(0,210,140,.4)",
              color:"#00d28c",padding:"9px 16px",borderRadius:8,fontSize:11,letterSpacing:1}}>
            {loading ? <span className="spin">⟳</span> : "⟳"}&nbsp;CHARGER
          </button>

          <button className="btn" onClick={goToday} disabled={loading||!serverOk}
            style={{background:"rgba(255,255,255,.04)",border:"1px solid rgba(255,255,255,.09)",
              color:"#8a9a8a",padding:"9px 12px",borderRadius:8,fontSize:11}}>
            AUJOURD'HUI
          </button>

          <button className="btn" onClick={()=>load(selDate,true)} disabled={loading||!serverOk}
            style={{background:"rgba(245,166,35,.08)",border:"1px solid rgba(245,166,35,.25)",
              color:"#f5a623",padding:"9px 12px",borderRadius:8,fontSize:11}}>
            ↺ FORCER MAJ
          </button>
        </div>

        {/* KPIs */}
        {data?.found && !loading && (
          <div className="up">
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10,flexWrap:"wrap"}}>
              <span style={{background:"rgba(0,210,140,.11)",border:"1px solid rgba(0,210,140,.28)",
                borderRadius:6,padding:"4px 12px",fontSize:11,color:"#00d28c",fontWeight:700}}>
                📌 {fmtFR(selDate)}
              </span>
              <span style={{fontSize:9,color:"#1e3a28"}}>Veille : {fmtFR(prevIso)}</span>
              <span style={{background:"rgba(0,180,100,.07)",border:"1px solid rgba(0,180,100,.2)",
                borderRadius:6,padding:"3px 10px",fontSize:9,color:"#4ab870"}}>
                ✅ Données réelles bkam.ma · {rawPts.length} points observés
              </span>
            </div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              {[
                {l:"Taux Directeur",v:"2.25%",       s:"BAM · stable mars 2025"},
                {l:"Spread 1A/30A", v:spreadVal,     s:"Pente de la courbe"},
                {l:"Court ≤6M",     v:avgShortVal,   s:"Moy. 1M · 3M · 6M"},
                {l:"Long ≥10A",     v:avgLongVal,    s:"Moy. 10A · 15A · 20A"},
                {l:"Overnight",     v:overnightVal,  s:"Marché interbancaire"},
              ].map(k=>(
                <div key={k.l} style={{flex:"1 1 100px",background:"rgba(255,255,255,.02)",
                  border:"1px solid rgba(255,255,255,.06)",borderRadius:8,padding:"8px 11px"}}>
                  <p style={{fontSize:7,color:"#1a3020",letterSpacing:2,textTransform:"uppercase"}}>{k.l}</p>
                  <p style={{fontSize:15,color:"#dde8d8",fontWeight:700,lineHeight:1.3}}>{k.v}</p>
                  <p style={{fontSize:7,color:"#122018",marginTop:1}}>{k.s}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ══ ONGLETS ══ */}
      <div style={{display:"flex",borderBottom:"1px solid rgba(255,255,255,.06)",
        padding:"0 18px",background:"#060c18"}}>
        {["courbe","tableau","brut"].map(t=>(
          <button key={t} className="btn" onClick={()=>setTab(t)}
            style={{padding:"10px 16px",fontSize:9,letterSpacing:2,textTransform:"uppercase",
              color:tab===t?"#00d28c":"#1e3a28",background:"none",
              borderBottom:tab===t?"2px solid #00d28c":"2px solid transparent",
              fontFamily:"'IBM Plex Mono',monospace"}}>
            {t==="courbe"?"📈 COURBE":t==="tableau"?"📊 TABLEAU":"🔬 BRUT"}
          </button>
        ))}
        <div style={{flex:1}}/>
        {tab==="courbe"&&(
          <button className="btn" onClick={()=>setShowPrev(v=>!v)}
            style={{padding:"10px 12px",fontSize:9,
              color:showPrev?"#f5a623":"#1e3a28",background:"none",
              fontFamily:"'IBM Plex Mono',monospace"}}>
            {showPrev?"◉":"○"} VEILLE
          </button>
        )}
      </div>

      {/* ══ CONTENU ══ */}
      <div style={{padding:"14px 18px"}}>

        {/* Erreur */}
        {error && (
          <div style={{background:"rgba(255,80,80,.06)",border:"1px solid rgba(255,80,80,.2)",
            borderLeft:"3px solid #ff6b6b",borderRadius:8,padding:"10px 14px",marginBottom:12}}>
            <p style={{fontSize:11,color:"#ff9999",fontWeight:700,marginBottom:4}}>❌ Erreur de connexion</p>
            <p style={{fontSize:10,color:"#aa7070",lineHeight:1.6}}>{error}</p>
            <p style={{fontSize:9,color:"#884444",marginTop:6}}>
              Vérifiez : 1) api.py tourne sur votre PC &nbsp;|&nbsp; 
              2) L'IP {serverIP} est correcte (cmd → ipconfig) &nbsp;|&nbsp;
              3) PC et téléphone sur le même WiFi
            </p>
          </div>
        )}

        {/* Chargement */}
        {loading && (
          <div style={{textAlign:"center",padding:"50px 0",color:"#1e3a28"}}>
            <div className="spin" style={{fontSize:28,display:"block",marginBottom:10}}>⟳</div>
            <p style={{fontSize:11,letterSpacing:1}}>Scraping bkam.ma + interpolation linéaire…</p>
            <p style={{fontSize:9,color:"#0e2018",marginTop:6}}>Méthode TMP.py · données réelles</p>
          </div>
        )}

        {/* Aucune donnée */}
        {!loading && data && !data.found && (
          <div style={{background:"rgba(245,166,35,.06)",border:"1px solid rgba(245,166,35,.2)",
            borderLeft:"3px solid #f5a623",borderRadius:8,padding:"12px 16px",marginTop:8}}>
            <p style={{fontSize:12,color:"#f5a623",fontWeight:700,marginBottom:4}}>
              📭 Aucune donnée pour le {fmtFR(selDate)}
            </p>
            <p style={{fontSize:10,color:"#7a6030",lineHeight:1.6}}>
              {data.message}<br/>Choisissez un jour ouvrable (lun–ven) ≥ 21/03/2023.
            </p>
          </div>
        )}

        {/* ─── COURBE ─── */}
        {!loading && tab==="courbe" && data?.found && (
          <div className="up">
            <div style={{display:"flex",gap:6,marginBottom:13,overflowX:"auto",paddingBottom:4}}>
              {DISPLAY.map(m=>{
                const taux=rates[m.idx], prev=prevRates[m.idx];
                const bps=taux!=null&&prev!=null?Math.round((taux-prev)*10000):null;
                return (
                  <div key={m.lbl} style={{minWidth:74,background:"rgba(255,255,255,.022)",
                    border:"1px solid rgba(255,255,255,.055)",borderRadius:10,
                    padding:"8px 6px 6px",textAlign:"center"}}>
                    <p style={{fontSize:7,color:"#1a3020",letterSpacing:.8,
                      textTransform:"uppercase",marginBottom:2}}>{m.lbl}</p>
                    <p style={{fontSize:14,color:"#dde8d8",fontWeight:700,lineHeight:1.3}}>
                      {taux!=null?(taux*100).toFixed(2):"—"}%
                    </p>
                    <p style={{fontSize:8,marginTop:1,
                      color:bps===null?"#1a3020":bps<0?"#00d28c":bps>0?"#ff6b6b":"#888"}}>
                      {bps===null?"—":bps>0?`▲ ${bps}pb`:bps<0?`▼ ${Math.abs(bps)}pb`:"= 0pb"}
                    </p>
                  </div>
                );
              })}
            </div>

            <div style={{background:"rgba(255,255,255,.013)",border:"1px solid rgba(255,255,255,.05)",
              borderRadius:12,padding:"16px 4px 12px"}}>
              <ResponsiveContainer width="100%" height={240}>
                <AreaChart data={chartData} margin={{top:6,right:12,left:0,bottom:0}}>
                  <defs>
                    <linearGradient id="gG" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="#00d28c" stopOpacity={.18}/>
                      <stop offset="95%" stopColor="#00d28c" stopOpacity={.01}/>
                    </linearGradient>
                    <linearGradient id="gA" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="#f5a623" stopOpacity={.1}/>
                      <stop offset="95%" stopColor="#f5a623" stopOpacity={.01}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.035)"/>
                  <XAxis dataKey="label"
                    tick={{fill:"#2a4a38",fontSize:9,fontFamily:"monospace"}}
                    axisLine={{stroke:"rgba(255,255,255,.06)"}} tickLine={false}/>
                  <YAxis domain={[minR,maxR]} tickLine={false} axisLine={false}
                    tick={{fill:"#2a4a38",fontSize:8,fontFamily:"monospace"}}
                    tickFormatter={v=>`${(v*100).toFixed(1)}%`}/>
                  <Tooltip content={<Tip/>}/>
                  <ReferenceLine y={0.0225} stroke="rgba(245,166,35,.2)" strokeDasharray="6 4"
                    label={{value:"TD 2.25%",fill:"rgba(245,166,35,.5)",fontSize:8}}/>
                  {showPrev&&dataPrev?.found&&(
                    <Area type="monotone" dataKey="prev"
                      stroke="#f5a623" strokeWidth={1.5} strokeDasharray="5 3"
                      fill="url(#gA)" dot={false} connectNulls/>
                  )}
                  <Area type="monotone" dataKey="taux"
                    stroke="#00d28c" strokeWidth={2.5} fill="url(#gG)"
                    dot={{fill:"#00d28c",r:3.5,strokeWidth:2,stroke:"#04080f"}}
                    activeDot={{r:6,fill:"#00d28c",stroke:"#fff",strokeWidth:2}}
                    connectNulls/>
                </AreaChart>
              </ResponsiveContainer>
              <div style={{display:"flex",gap:16,justifyContent:"center",marginTop:9,flexWrap:"wrap"}}>
                {[
                  {c:"#00d28c",l:fmtFR(selDate),s:true},
                  ...(showPrev&&dataPrev?.found?[{c:"rgba(245,166,35,.8)",l:fmtFR(prevIso),s:false}]:[]),
                  {c:"rgba(245,166,35,.35)",l:"TD 2.25%",s:false},
                ].map(item=>(
                  <div key={item.l} style={{display:"flex",alignItems:"center",gap:5}}>
                    <div style={{width:16,height:item.s?2.5:1.5,background:item.c,borderRadius:2,opacity:.9}}/>
                    <span style={{fontSize:8,color:"#2a4a38"}}>{item.l}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ─── TABLEAU ─── */}
        {!loading && tab==="tableau" && data?.found && (
          <div className="up">
            <div style={{background:"rgba(255,255,255,.013)",border:"1px solid rgba(255,255,255,.05)",
              borderRadius:12,overflow:"hidden"}}>
              <div style={{display:"grid",gridTemplateColumns:"1fr .8fr 1.2fr 1.2fr 1fr",
                background:"rgba(0,210,140,.07)",borderBottom:"1px solid rgba(0,210,140,.12)",
                padding:"9px 14px"}}>
                {["Maturité","L (ans)","Taux Actuel","Veille","Variation"].map(h=>(
                  <span key={h} style={{fontSize:8,color:"#00d28c",letterSpacing:2,textTransform:"uppercase"}}>{h}</span>
                ))}
              </div>
              {tableData.map((row,i)=>(
                <div key={row.lbl} className="rh"
                  style={{display:"grid",gridTemplateColumns:"1fr .8fr 1.2fr 1.2fr 1fr",
                    padding:"10px 14px",alignItems:"center",
                    borderBottom:i<tableData.length-1?"1px solid rgba(255,255,255,.035)":"none",
                    background:i%2===0?"transparent":"rgba(255,255,255,.008)"}}>
                  <span style={{fontSize:12,color:"#dde8d8",fontWeight:700}}>{row.lbl}</span>
                  <span style={{fontSize:9,color:"#1e3a28"}}>{L_YEARS[i].toFixed(3)}</span>
                  <span style={{fontSize:13,color:"#00d28c",fontWeight:700}}>
                    {row.taux!=null?(row.taux*100).toFixed(3)+"%":"—"}
                  </span>
                  <span style={{fontSize:11,color:"#3a6a4a"}}>
                    {row.prev!=null?(row.prev*100).toFixed(3)+"%":"—"}
                  </span>
                  <span style={{fontSize:10,fontWeight:700,
                    color:row.bps===null?"#1e3a28":row.bps<0?"#00d28c":row.bps>0?"#ff6b6b":"#888"}}>
                    {row.bps===null?"—":row.bps>0?`▲ +${row.bps}pb`:row.bps<0?`▼ ${row.bps}pb`:"= 0pb"}
                  </span>
                </div>
              ))}
              <div style={{background:"rgba(0,210,140,.03)",borderTop:"1px solid rgba(0,210,140,.08)",
                padding:"10px 14px",display:"flex",gap:18,flexWrap:"wrap"}}>
                {[{l:"Court ≤6M",v:avgShortVal},{l:"Long ≥10A",v:avgLongVal},
                  {l:"Spread 1A/30A",v:spreadVal},{l:"Overnight",v:overnightVal}].map(s=>(
                  <div key={s.l}>
                    <p style={{fontSize:7,color:"#0e2018",letterSpacing:1,textTransform:"uppercase"}}>{s.l}</p>
                    <p style={{fontSize:12,color:"#5a9870",fontWeight:700}}>{s.v}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ─── DONNÉES BRUTES ─── */}
        {!loading && tab==="brut" && data?.found && (
          <div className="up">
            <div style={{background:"rgba(0,210,140,.03)",border:"1px solid rgba(0,210,140,.12)",
              borderRadius:8,padding:"10px 14px",marginBottom:12}}>
              <p style={{fontSize:10,color:"#4a8a64",lineHeight:1.6}}>
                <b style={{color:"#00d28c"}}>{rawPts.length} points</b> observés sur bkam.ma
                le {fmtFR(selDate)}, avant interpolation.
              </p>
            </div>
            <div style={{background:"rgba(255,255,255,.013)",border:"1px solid rgba(255,255,255,.05)",
              borderRadius:12,overflow:"hidden"}}>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",
                background:"rgba(0,210,140,.07)",borderBottom:"1px solid rgba(0,210,140,.12)",
                padding:"9px 14px"}}>
                {["Maturité (années)","Taux BAM","Date d'échéance"].map(h=>(
                  <span key={h} style={{fontSize:8,color:"#00d28c",letterSpacing:1.5,textTransform:"uppercase"}}>{h}</span>
                ))}
              </div>
              {[...rawPts].sort((a,b)=>a.mat_years-b.mat_years).map((pt,i)=>(
                <div key={i} className="rh"
                  style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",
                    padding:"10px 14px",
                    borderBottom:i<rawPts.length-1?"1px solid rgba(255,255,255,.035)":"none",
                    background:i%2===0?"transparent":"rgba(255,255,255,.008)"}}>
                  <span style={{fontSize:12,color:"#dde8d8"}}>{pt.mat_years.toFixed(4)}</span>
                  <span style={{fontSize:13,color:"#00d28c",fontWeight:700}}>{(pt.rate*100).toFixed(3)}%</span>
                  <span style={{fontSize:10,color:"#3a6a4a"}}>{pt.date_echeance}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Footer */}
        <div style={{marginTop:18,paddingTop:12,borderTop:"1px solid rgba(255,255,255,.04)",
          display:"flex",justifyContent:"space-between",flexWrap:"wrap",gap:6}}>
          <p style={{fontSize:7,color:"#0a1a10"}}>BANK AL-MAGHRIB · BDT · SCRAPING RÉEL + INTERPOLATION LINÉAIRE TMP.PY</p>
          <p style={{fontSize:7,color:"#0a1a10"}}>Jours ouvrables · Données disponibles dès 15h00</p>
        </div>
      </div>
    </div>
  );
}
