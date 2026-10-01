// Slide-in panel showing one receipt: the exact external call behind a cited value.
import { useEffect, useState } from 'react';
import type { Receipt } from '../../../shared/types';
import { api } from '../lib/api';

function JsonNode({ k, v, depth }: { k?: string; v: unknown; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  const label = k !== undefined ? <span className="j-key">{k}: </span> : null;
  if (v === null || typeof v !== 'object') {
    const cls = v === null ? 'j-null' : typeof v === 'string' ? 'j-str' : typeof v === 'number' ? 'j-num' : 'j-bool';
    return <div className="j-line">{label}<span className={cls}>{typeof v === 'string' ? JSON.stringify(v) : String(v)}</span></div>;
  }
  const isArr = Array.isArray(v);
  const entries = isArr ? (v as unknown[]).map((x, i) => [String(i), x] as const) : Object.entries(v as Record<string, unknown>);
  const [o, c] = isArr ? ['[', ']'] : ['{', '}'];
  if (!entries.length) return <div className="j-line">{label}<span className="j-punc">{o}{c}</span></div>;
  return (
    <div className="j-node">
      <button className="j-toggle" onClick={() => setOpen(!open)}>
        <span className={`j-caret ${open ? 'open' : ''}`} />{label}<span className="j-punc">{o}</span>
        {!open && <span className="j-summary">{isArr ? `${entries.length} items` : `${entries.length} keys`}</span>}
        {!open && <span className="j-punc">{c}</span>}
      </button>
      {open && (
        <div className="j-children">
          {entries.slice(0, 500).map(([ek, ev]) => <JsonNode key={ek} k={isArr ? undefined : ek} v={ev} depth={depth + 1} />)}
          {entries.length > 500 && <div className="j-line muted">... {entries.length - 500} more</div>}
        </div>
      )}
      {open && <div className="j-line"><span className="j-punc">{c}</span></div>}
    </div>
  );
}

export default function ReceiptPanel({ receiptId, deckId, onClose }: { receiptId: string | null; deckId: string; onClose: () => void }) {
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [raw, setRaw] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setReceipt(null);
    setError(null);
    if (!receiptId) return;
    let live = true;
    api.receipt(deckId, receiptId).then((r) => live && setReceipt(r)).catch((e) => live && setError(String(e.message || e)));
    return () => { live = false; };
  }, [deckId, receiptId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const open = !!receiptId;
  const ok = receipt && receipt.status >= 200 && receipt.status < 300;
  const pretty = receipt ? JSON.stringify(receipt.json, null, 2) : '';

  return (
    <>
      <div className={`rp-backdrop ${open ? 'open' : ''}`} onClick={onClose} />
      <aside className={`receipt-panel ${open ? 'open' : ''}`} aria-hidden={!open}>
        <div className="rp-head">
          <div>
            <div className="rp-eyebrow">Receipt</div>
            <div className="rp-id">{receiptId}</div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          </button>
        </div>
        {error && <p className="error-line">{error}</p>}
        {!receipt && !error && open && <div className="rp-loading"><span className="spinner spinner-sm" /> Loading receipt...</div>}
        {receipt && (
          <div className="rp-body">
            <div className="rp-grid">
              <span>Source</span><b className={`src src-${receipt.source}`}>{receipt.source}</b>
              <span>Endpoint</span><code className="rp-endpoint">{receipt.endpoint}</code>
              <span>Status</span><b className={ok ? 'ok' : 'bad'}>{receipt.status}</b>
              <span>Latency</span><b>{receipt.ms} ms</b>
              <span>Fetched</span><b>{new Date(receipt.at).toLocaleString()}</b>
            </div>
            {receipt.params && Object.keys(receipt.params).length > 0 && (
              <>
                <div className="rp-section">Params</div>
                <pre className="rp-pre rp-params">{JSON.stringify(receipt.params, null, 2)}</pre>
              </>
            )}
            <div className="rp-section rp-section-row">
              <span>Response</span>
              <span className="rp-tools">
                <button className="link-btn" onClick={() => setRaw(!raw)}>{raw ? 'Tree' : 'Raw'}</button>
                <button className="link-btn" onClick={() => { navigator.clipboard?.writeText(pretty).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }); }}>{copied ? 'Copied' : 'Copy'}</button>
              </span>
            </div>
            <div className="rp-json">
              {raw ? <pre className="rp-pre">{pretty}</pre> : <JsonNode v={receipt.json} depth={0} />}
            </div>
          </div>
        )}
      </aside>
    </>
  );
}
