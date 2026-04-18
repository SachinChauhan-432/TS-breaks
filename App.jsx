import { useState, useCallback } from "react";
import * as XLSX from "xlsx";

const STORAGE_KEY = "tsregfails_webhook";

function parseExcel(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type: "array", cellDates: true });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
        resolve(rows);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

function buildSummary(rows) {
  const total = rows.length;
  const firmCounts = {};
  const productCounts = {};
  const errorGroups = {};
  const firmDetails = {};
  const productDetails = {};

  for (const r of rows) {
    const errFull = (r["Error"] || "").trim();
    if (!errorGroups[errFull]) errorGroups[errFull] = [];
    errorGroups[errFull].push(r);

    const firm = r["Party Firm Name"] || "Unknown";
    firmCounts[firm] = (firmCounts[firm] || 0) + 1;
    
    if (!firmDetails[firm]) firmDetails[firm] = [];
    firmDetails[firm].push(r);

    const prod = r["Product Type"] || "Unknown";
    productCounts[prod] = (productCounts[prod] || 0) + 1;
    
    if (!productDetails[prod]) productDetails[prod] = [];
    productDetails[prod].push(r);
  }

  return { total, errorGroups, firmCounts, productCounts, firmDetails, productDetails };
}

function formatReportDate(dateObj) {
  const d = dateObj.getDate();
  const suffix = d === 1 || d === 21 || d === 31 ? "st"
    : d === 2 || d === 22 ? "nd"
    : d === 3 || d === 23 ? "rd" : "th";
  const month = dateObj.toLocaleString("en-GB", { month: "long" });
  const year = dateObj.getFullYear();
  return `${d}${suffix} ${month} ${year}`;
}

function buildGChatMessage(summary, reportDate) {
  const { total, errorGroups } = summary;
  const errorEntries = Object.entries(errorGroups).sort((a, b) => b[1].length - a[1].length);

  let tradeBlocks = "";
  errorEntries.forEach(([errMsg, rows], idx) => {
    const trns = [...new Set(
      rows.map(r => (r["Party Reference Number"] || "").toString().trim()).filter(Boolean)
    )];
    const dtccIds = [...new Set(
      rows.map(r => (r["DTCC Trade Reference Identifer"] || "").toString().trim()).filter(Boolean)
    )];

    const trnLine = `TRN - ${trns.length}\n${trns.join("\n")}`;
    const dtccLine = dtccIds.length ? `\nDTCC ID\n${dtccIds.join("\n")}` : "";

    tradeBlocks += `\n${idx + 1}) ${errMsg}\n${trnLine}${dtccLine}\n`;
  });

  return `__Duco Breaks - ${reportDate}__\nTotal count - ${total} Trade\n${tradeBlocks}`.trim();
}

async function sendToGChat(webhookUrl, message) {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: message }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
}

// ─── UI Helpers ───────────────────────────────────────────────────────────────

function Card({ children, className = "" }) {
  return <div className={`bg-zinc-900/90 backdrop-blur-sm rounded-3xl border border-zinc-800 shadow-[0_8px_30px_rgb(0,0,0,0.3)] transition-all duration-300 ${className}`}>{children}</div>;
}

function Badge({ color, children }) {
  const c = { green: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30", gray: "bg-zinc-800 text-zinc-400 border-zinc-700" };
  return <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold border ${c[color] || c.gray}`}>{children}</span>;
}

function StatCard({ icon, label, value }) {
  return (
    <div className="bg-zinc-900 rounded-3xl p-5 shadow-[0_8px_30px_rgb(0,0,0,0.3)] border border-zinc-800 flex items-center gap-4 hover:-translate-y-1 transition-transform duration-300">
      <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-zinc-800 to-zinc-900 flex items-center justify-center text-3xl border border-zinc-700 shrink-0 shadow-sm">{icon}</div>
      <div>
        <div className="text-3xl font-black text-white tracking-tight">{value}</div>
        <div className="text-xs font-bold text-zinc-500 uppercase tracking-widest mt-1">{label}</div>
      </div>
    </div>
  );
}

function BreakdownBar({ title, icon, data, onRowClick }) {
  const sorted = Object.entries(data).sort((a, b) => b[1] - a[1]);
  const max = sorted[0]?.[1] || 1;
  return (
    <div>
      <h3 className="text-xs font-bold text-zinc-500 uppercase tracking-widest mb-5 flex items-center gap-2"><span>{icon}</span> {title}</h3>
      <div className="space-y-4">
        {sorted.map(([k, v]) => (
          <div key={k} 
               onClick={() => onRowClick && onRowClick(k)}
               className={`group relative ${onRowClick ? "cursor-pointer" : ""}`}>
            <div className="flex justify-between text-sm mb-2 relative z-10 px-1">
              <span className={`truncate font-semibold transition-colors ${onRowClick ? "group-hover:text-pink-400 text-zinc-300" : "text-zinc-300"}`} title={k}>{k}</span>
              <span className="font-bold text-white ml-3 shrink-0">{v}</span>
            </div>
            <div className="h-2.5 bg-zinc-800 rounded-full overflow-hidden">
              <div className={`h-full rounded-full transition-all duration-1000 ease-out ${onRowClick ? "bg-pink-500 group-hover:bg-pink-400" : "bg-zinc-600"}`} style={{ width: `${(v / max) * 100}%` }} />
            </div>
            {onRowClick && <div className="absolute -inset-x-3 -inset-y-2 bg-pink-500/10 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-200 z-0 pointer-events-none" />}
          </div>
        ))}
      </div>
    </div>
  );
}

function MessagePreview({ message }) {
  return (
    <div className="bg-zinc-950 rounded-2xl p-5 text-sm text-zinc-300 leading-relaxed space-y-0.5 border border-zinc-800 shadow-inner">
      {message.split("\n").map((line, i) => {
        const isTitle  = line.startsWith("__") && line.endsWith("__");
        const isTotal  = line.startsWith("Total count");
        const isNum    = /^\d+\)/.test(line);
        const isTrnHdr = line.startsWith("TRN -") || line === "DTCC ID";
        const isEmpty  = !line.trim();

        if (isTitle)  return <div key={i} className="font-black text-white text-base pb-2">{line.replace(/__/g, "")}</div>;
        if (isTotal)  return <div key={i} className="font-bold text-zinc-400">{line}</div>;
        if (isNum)    return <div key={i} className="mt-4 font-bold text-pink-500">{line}</div>;
        if (isTrnHdr) return <div key={i} className="mt-1.5 text-xs font-bold text-pink-400 uppercase tracking-widest">{line}</div>;
        if (isEmpty)  return <div key={i} className="h-2" />;
        return <div key={i} className="font-mono text-xs text-zinc-500 pl-1">{line}</div>;
      })}
    </div>
  );
}

function FirmDetailsModal({ firmName, rows, onClose }) {
  if (!firmName) return null;
  
  const errorCounts = {};
  rows.forEach(r => {
    const err = (r["Error"] || "Unknown").trim();
    errorCounts[err] = (errorCounts[err] || 0) + 1;
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity animate-in fade-in duration-300" onClick={onClose} />
      <div className="bg-zinc-900 rounded-3xl shadow-2xl shadow-pink-900/20 border border-zinc-800 w-full max-w-2xl max-h-[85vh] flex flex-col relative z-10 animate-in fade-in zoom-in-95 duration-300">
        <div className="p-6 border-b border-zinc-800 flex justify-between items-start bg-zinc-900/50 backdrop-blur-md rounded-t-3xl z-20">
          <div>
            <h2 className="text-2xl font-black text-white tracking-tight">{firmName}</h2>
            <p className="text-sm font-medium text-zinc-400 mt-1">{rows.length} Total Fails</p>
          </div>
          <button onClick={onClose} className="w-10 h-10 flex items-center justify-center rounded-full bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-white transition-colors">✕</button>
        </div>
        <div className="p-6 overflow-y-auto">
          <div className="space-y-6">
            {Object.entries(errorCounts).sort((a,b)=>b[1]-a[1]).map(([err, count], idx) => {
              const specificRows = rows.filter(r => (r["Error"] || "").trim() === err);
              return (
                <div key={idx} className="bg-zinc-950/50 rounded-2xl p-5 border border-zinc-800">
                  <div className="flex justify-between items-start mb-4 gap-4">
                    <h3 className="font-bold text-white text-sm leading-snug">{err}</h3>
                    <Badge color="gray">{count}</Badge>
                  </div>
                  <div className="space-y-3">
                    {specificRows.map((r, i) => (
                      <div key={i} className="bg-zinc-900 rounded-xl p-4 text-xs border border-zinc-800 shadow-sm flex flex-col gap-2 hover:border-pink-500/30 transition-colors">
                        <div className="flex justify-between items-center">
                          <span className="text-zinc-500 font-medium uppercase tracking-wider">TRN</span>
                          <span className="font-mono font-bold text-zinc-300">{r["Party Reference Number"] || "-"}</span>
                        </div>
                        <div className="flex justify-between items-center">
                          <span className="text-zinc-500 font-medium uppercase tracking-wider">DTCC ID</span>
                          <span className="font-mono font-bold text-zinc-300">{r["DTCC Trade Reference Identifer"] || "-"}</span>
                        </div>
                        <div className="flex justify-between items-center">
                          <span className="text-zinc-500 font-medium uppercase tracking-wider">Product</span>
                          <span className="font-semibold text-pink-400 bg-pink-500/10 px-2 py-0.5 rounded">{r["Product Type"] || "-"}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function ProductDetailsModal({ productName, rows, onClose }) {
  if (!productName) return null;
  
  const firmCounts = {};
  rows.forEach(r => {
    const firm = (r["Party Firm Name"] || "Unknown").trim();
    firmCounts[firm] = (firmCounts[firm] || 0) + 1;
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity animate-in fade-in duration-300" onClick={onClose} />
      <div className="bg-zinc-900 rounded-3xl shadow-2xl shadow-pink-900/20 border border-zinc-800 w-full max-w-2xl max-h-[85vh] flex flex-col relative z-10 animate-in fade-in zoom-in-95 duration-300">
        <div className="p-6 border-b border-zinc-800 flex justify-between items-start bg-zinc-900/50 backdrop-blur-md rounded-t-3xl z-20">
          <div>
            <h2 className="text-2xl font-black text-white tracking-tight">{productName}</h2>
            <p className="text-sm font-medium text-zinc-400 mt-1">{rows.length} Total Fails</p>
          </div>
          <button onClick={onClose} className="w-10 h-10 flex items-center justify-center rounded-full bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-white transition-colors">✕</button>
        </div>
        <div className="p-6 overflow-y-auto">
          <div className="space-y-6">
            {Object.entries(firmCounts).sort((a,b)=>b[1]-a[1]).map(([firm, count], idx) => {
              const specificRows = rows.filter(r => (r["Party Firm Name"] || "Unknown").trim() === firm);
              return (
                <div key={idx} className="bg-zinc-950/50 rounded-2xl p-5 border border-zinc-800">
                  <div className="flex justify-between items-start mb-4 gap-4">
                    <h3 className="font-bold text-white text-sm leading-snug">{firm}</h3>
                    <Badge color="gray">{count}</Badge>
                  </div>
                  <div className="space-y-3">
                    {specificRows.map((r, i) => (
                      <div key={i} className="bg-zinc-900 rounded-xl p-4 text-xs border border-zinc-800 shadow-sm flex flex-col gap-2 hover:border-pink-500/30 transition-colors">
                        <div className="flex justify-between items-center">
                          <span className="text-zinc-500 font-medium uppercase tracking-wider">TRN</span>
                          <span className="font-mono font-bold text-zinc-300">{r["Party Reference Number"] || "-"}</span>
                        </div>
                        <div className="flex justify-between items-center">
                          <span className="text-zinc-500 font-medium uppercase tracking-wider">Error</span>
                          <span className="font-semibold text-pink-400 bg-pink-500/10 px-2 py-0.5 rounded text-right max-w-[60%] truncate" title={r["Error"]}>{r["Error"] || "-"}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [webhook, setWebhook] = useState(() => { try { return localStorage.getItem(STORAGE_KEY) || ""; } catch { return ""; } });
  const [showWebhook, setShowWebhook] = useState(false);
  const [file, setFile] = useState(null);
  const [summary, setSummary] = useState(null);
  const [message, setMessage] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [status, setStatus] = useState(null);
  const [activeTab, setActiveTab] = useState("preview");
  const [selectedFirm, setSelectedFirm] = useState(null);
  const [selectedProduct, setSelectedProduct] = useState(null);

  const saveWebhook = (v) => { setWebhook(v); try { localStorage.setItem(STORAGE_KEY, v); } catch {} };

  const processFile = async (f) => {
    setFile(f); setSummary(null); setMessage(""); setStatus(null); setSelectedFirm(null); setSelectedProduct(null);
    try {
      const rows = await parseExcel(f);
      const s = buildSummary(rows);
      setSummary(s);
      setMessage(buildGChatMessage(s, formatReportDate(new Date())));
    } catch (err) {
      setStatus({ type: "error", text: "Failed to parse Excel: " + err.message });
    }
  };

  const onFileInput = (e) => { const f = e.target.files[0]; if (f) processFile(f); };
  const onDrop = useCallback((e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) processFile(f); }, []);

  const handleSend = async () => {
    if (!webhook) return setStatus({ type: "error", text: "Set a Google Chat webhook URL first (⚙️ above)." });
    if (!message) return setStatus({ type: "error", text: "Upload an Excel file first." });
    setStatus({ type: "sending", text: "Sending to Google Chat…" });
    try {
      await sendToGChat(webhook, message);
      setStatus({ type: "success", text: "✅ Message sent to Google Chat!" });
    } catch (err) {
      setStatus({ type: "error", text: "Send failed: " + err.message });
    }
  };

  const isWeekday = [1,2,3,4,5].includes(new Date().getDay());

  return (
    <div className="min-h-screen bg-black text-zinc-100 selection:bg-pink-500/30 font-sans">
      {/* Header */}
      <div className="bg-zinc-950/80 backdrop-blur-md border-b border-zinc-800 px-6 py-4 flex items-center justify-between sticky top-0 z-20 shadow-sm">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 bg-gradient-to-br from-pink-500 to-rose-600 rounded-xl flex items-center justify-center text-white font-black text-sm shadow-md shadow-pink-500/20 shrink-0">TS</div>
          <div>
            <div className="font-bold text-white text-sm tracking-tight">Duco Breaks Notifier</div>
            <div className="text-xs font-medium text-zinc-500">TS Reg Fails → Google Chat</div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Badge color={isWeekday ? "green" : "gray"}>{isWeekday ? "Weekday ✓" : "Weekend"}</Badge>
          <button onClick={() => setShowWebhook(v => !v)}
            className="flex items-center gap-2 text-sm font-semibold px-4 py-2 rounded-xl border border-zinc-800 hover:bg-zinc-800 hover:border-zinc-700 text-zinc-300 transition-all shadow-sm">
            ⚙️ Webhook
            {webhook && <span className="w-2.5 h-2.5 bg-emerald-500 rounded-full shadow-sm" />}
          </button>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 py-6 space-y-5">

        {/* Webhook */}
        {showWebhook && (
          <Card className="p-5">
            <div className="font-semibold text-zinc-300 text-sm mb-1">🔗 Google Chat Webhook URL</div>
            <div className="text-xs text-zinc-500 mb-3">Google Chat → Space → Apps &amp; integrations → Webhooks → Add webhook</div>
            <div className="flex gap-2">
              <input type="password" value={webhook} onChange={e => saveWebhook(e.target.value)}
                placeholder="https://chat.googleapis.com/v1/spaces/..."
                className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-pink-500 text-white placeholder-zinc-700" />
              <button onClick={() => setShowWebhook(false)}
                className="px-4 py-2 bg-pink-600 text-white rounded-lg text-sm hover:bg-pink-700 transition font-medium">Save</button>
            </div>
            {webhook && <div className="text-xs text-emerald-400 mt-2">✓ Webhook saved</div>}
          </Card>
        )}

        {/* Upload */}
        <Card className="p-5">
          <div className="font-semibold text-zinc-300 text-sm mb-3">📂 Upload Excel Export</div>
          <label onDrop={onDrop} onDragOver={e => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)}
            className={`flex flex-col items-center justify-center border-2 border-dashed rounded-2xl p-8 cursor-pointer transition-all duration-300
              ${dragOver ? "border-pink-500 bg-pink-500/10" : file ? "border-emerald-500/50 bg-emerald-500/10" : "border-zinc-800 hover:border-pink-500/50 hover:bg-zinc-800/50"}`}>
            <input type="file" accept=".xlsx,.xls" className="hidden" onChange={onFileInput} />
            <div className="text-3xl mb-2">{file ? "✅" : "📊"}</div>
            {file ? (
              <><p className="font-medium text-white text-sm">{file.name}</p><p className="text-xs text-zinc-500 mt-1">Click to replace</p></>
            ) : (
              <><p className="font-medium text-zinc-300 text-sm">Drop TSREGFAILS Excel here or click to browse</p><p className="text-xs text-zinc-600 mt-1">.xlsx / .xls</p></>
            )}
          </label>
        </Card>

        {/* Results */}
        {summary && (
          <>
            <div className="grid grid-cols-3 gap-3">
              <StatCard icon="🚨" label="Total Fails" value={summary.total} />
              <StatCard icon="🔴" label="Error Types" value={Object.keys(summary.errorGroups).length} />
              <StatCard icon="🏦" label="Firms" value={Object.keys(summary.firmCounts).length} />
            </div>

            <Card className="p-7">
              <div className="grid md:grid-cols-2 gap-10">
                <BreakdownBar title="By Party Firm" icon="🏦" data={summary.firmCounts} onRowClick={(firm) => setSelectedFirm(firm)} />
                <BreakdownBar title="By Product Type" icon="📦" data={summary.productCounts} onRowClick={(prod) => setSelectedProduct(prod)} />
              </div>
            </Card>

            <Card className="overflow-hidden">
              <div className="flex border-b border-zinc-800 bg-zinc-950/50 justify-between items-center pr-2">
                <div className="flex">
                  {[["preview","💬 Preview"],["edit","✏️ Edit"]].map(([tab, label]) => (
                    <button key={tab} onClick={() => setActiveTab(tab)}
                      className={`px-5 py-3 text-sm font-medium transition-colors ${activeTab === tab ? "border-b-2 border-pink-500 text-pink-400" : "text-zinc-500 hover:text-zinc-300"}`}>
                      {label}
                    </button>
                  ))}
                </div>
                <button onClick={() => { navigator.clipboard.writeText(message); setStatus({ type: "success", text: "✅ Message copied to clipboard!" }); }}
                  className="px-4 py-1.5 text-xs font-bold bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white rounded-lg transition-colors flex items-center gap-2">
                  📋 Copy Text
                </button>
              </div>
              <div className="p-5">
                {activeTab === "preview"
                  ? <MessagePreview message={message} />
                  : <textarea value={message} onChange={e => setMessage(e.target.value)} rows={24}
                      className="w-full bg-zinc-950 text-zinc-300 font-mono text-xs border border-zinc-800 rounded-xl p-4 resize-none focus:outline-none focus:ring-2 focus:ring-pink-500 leading-relaxed" />
                }
              </div>
            </Card>

            <div className="flex flex-col gap-3 pb-6">
              {status && (
                <div className={`rounded-xl px-4 py-3 text-sm text-center font-medium border
                  ${status.type==="success" ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                  : status.type==="error"   ? "bg-rose-500/10 text-rose-400 border-rose-500/20"
                  :                           "bg-pink-500/10 text-pink-400 border-pink-500/20"}`}>
                  {status.text}
                </div>
              )}
              <button onClick={handleSend} disabled={status?.type==="sending"}
                className="w-full py-4 rounded-2xl bg-gradient-to-r from-pink-600 to-rose-600 hover:from-pink-500 hover:to-rose-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold text-base transition-all flex items-center justify-center gap-2 shadow-lg shadow-pink-600/20 hover:shadow-pink-600/40">
                {status?.type==="sending" ? <><span className="animate-spin">⏳</span> Sending…</> : <><span>🚀</span> Send to Google Chat</>}
              </button>
              {!webhook && <p className="text-xs font-medium text-center text-amber-500 bg-amber-500/10 py-2 rounded-xl border border-amber-500/20">⚠️ Configure your webhook via ⚙️ first</p>}
            </div>
          </>
        )}
      </div>

      {/* Modals */}
      {selectedFirm && summary?.firmDetails[selectedFirm] && (
        <FirmDetailsModal 
          firmName={selectedFirm} 
          rows={summary.firmDetails[selectedFirm]} 
          onClose={() => setSelectedFirm(null)} 
        />
      )}
      {selectedProduct && summary?.productDetails[selectedProduct] && (
        <ProductDetailsModal 
          productName={selectedProduct} 
          rows={summary.productDetails[selectedProduct]} 
          onClose={() => setSelectedProduct(null)} 
        />
      )}
    </div>
  );
}
