import { useState } from 'react';
import type { ShareInfo } from '../../../shared/types';
import '../voice/voice.css';

export default function ShareButton({ deckId }: { deckId: string }) {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const share = async () => {
    setOpen(true);
    setErr(null);
    setCopied(false);
    if (info) return;
    setLoading(true);
    try {
      const r = await fetch('/api/share', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deckId }) });
      if (!r.ok) throw new Error(`Share failed (${r.status})`);
      setInfo((await r.json()) as ShareInfo);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const copy = async () => {
    if (!info) return;
    try { await navigator.clipboard.writeText(info.url); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { setErr('Copy failed - select the link manually'); }
  };

  return (
    <>
      <button className="vx-btn" onClick={share}>Share</button>
      {open && (
        <div className="vx-modal-bg" onClick={() => setOpen(false)}>
          <div className="vx-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Share deck">
            <h3>Share this deck</h3>
            {loading && <div className="vx-hint">Opening a public link...</div>}
            {err && <div className="vx-err">{err}</div>}
            {info && (
              <>
                <img src={info.qrDataUrl} alt="QR code for the share link" />
                <div className="vx-row">
                  <input className="vx-input" readOnly value={info.url} onFocus={(e) => e.currentTarget.select()} />
                  <button className="vx-btn vx-btn-primary" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
                </div>
                <div className="vx-hint">Viewers can browse, present and ask questions. Their questions fork a private copy; your deck is never edited.</div>
              </>
            )}
            <div className="vx-row" style={{ justifyContent: 'flex-end' }}>
              {info && <a className="vx-btn" href={info.url} target="_blank" rel="noreferrer">Open</a>}
              <button className="vx-btn" onClick={() => setOpen(false)}>Done</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export { ShareButton };
