import { useEffect, useRef, useState } from 'react';
import type { SearchHit, Suggestion, SuggestResponse } from '../../../shared/types';
import { api, navigate } from '../lib/api';
import { Monogram } from '../pages/Landing';

const STORE_KEY = 'dealdeck.thesis.v1';
const STATUS = ['Reading your thesis...', 'Studying the fund portfolio...', 'Scanning Dealroom...', 'Filtering by stage and geography...', 'Ranking fits...', 'Writing why each one fits...'];

type Fund = { uuid: string; name: string; image: string | null };
type Saved = { thesis: string; fund: Fund | null };

function load(): Saved {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { thesis: '', fund: null };
    const v = JSON.parse(raw);
    return { thesis: typeof v.thesis === 'string' ? v.thesis : '', fund: v.fund && v.fund.uuid ? v.fund : null };
  } catch { return { thesis: '', fund: null }; }
}
function save(s: Saved) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
}

function hqOf(s: Suggestion) { return [s.hqCity, s.hqCountry].filter(Boolean).join(', '); }

export default function ThesisPanel({ disabled }: { disabled?: boolean }) {
  const initial = useRef(load()).current;
  const [open, setOpen] = useState(!!initial.thesis || !!initial.fund);
  const [thesis, setThesis] = useState(initial.thesis);
  const [fund, setFund] = useState<Fund | null>(initial.fund);
  const [fq, setFq] = useState('');
  const [fHits, setFHits] = useState<SearchHit[]>([]);
  const [fOpen, setFOpen] = useState(false);
  const [fActive, setFActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState(0);
  const [result, setResult] = useState<SuggestResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [building, setBuilding] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { save({ thesis, fund }); }, [thesis, fund]);
  useEffect(() => { if (open && !initial.thesis) setTimeout(() => areaRef.current?.focus(), 260); }, [open]);

  // Fund autocomplete: same /api/search, investors only.
  useEffect(() => {
    const term = fq.trim();
    if (term.length < 2) { abortRef.current?.abort(); setFHits([]); return; }
    const t = setTimeout(() => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      api.search(term, ac.signal)
        .then((res) => { if (ac.signal.aborted) return; setFHits(res.filter((h) => h.type === 'investor').slice(0, 6)); setFActive(0); setFOpen(true); })
        .catch(() => { if (!ac.signal.aborted) setFHits([]); });
    }, 200);
    return () => clearTimeout(t);
  }, [fq]);

  useEffect(() => {
    if (!loading) return;
    setStep(0);
    const t = setInterval(() => setStep((s) => Math.min(s + 1, STATUS.length - 1)), 3200);
    return () => clearInterval(t);
  }, [loading]);

  function pickFund(h: SearchHit) { setFund({ uuid: h.uuid, name: h.name, image: h.image }); setFq(''); setFHits([]); setFOpen(false); }

  function onFundKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setFActive((a) => Math.min(a + 1, fHits.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setFActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (fHits[fActive]) pickFund(fHits[fActive]); }
    else if (e.key === 'Escape') setFOpen(false);
  }

  const canRun = (thesis.trim().length > 0 || !!fund) && !loading;

  async function find() {
    if (!canRun) return;
    setLoading(true); setError(null); setResult(null);
    try {
      const res = await api.suggest({ thesis: thesis.trim() || undefined, fundUuid: fund?.uuid, fundName: fund?.name, limit: 6 });
      if (!res || !Array.isArray(res.suggestions)) throw new Error('Unexpected response from the sourcing agent');
      setResult(res);
      if (!res.suggestions.length) setError('No companies matched this thesis. Try loosening stage, geography or sector.');
    } catch (e: any) {
      const msg = String(e?.message || e);
      setError(/404|not found/i.test(msg) ? 'Thesis sourcing is not available on this server yet. Try again in a minute.' : msg);
    } finally { setLoading(false); }
  }

  async function build(s: Suggestion) {
    setBuilding(s.uuid); setError(null);
    const t = thesis.trim() || (result?.thesisSummary ?? '') || (fund ? `Fits the portfolio of ${fund.name}` : '');
    try {
      const { id } = await api.createDeck({ uuid: s.uuid, kind: 'company', name: s.name, thesis: t || undefined });
      navigate(`/d/${id}`);
    } catch (e: any) { setError(String(e?.message || e)); setBuilding(null); }
  }

  return (
    <div className="thesis">
      {!open && (
        <button className="thesis-toggle" onClick={() => setOpen(true)} disabled={disabled}>
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 3l2.2 5.6L20 9.5l-4.4 3.9L17 19l-5-3-5 3 1.4-5.6L4 9.5l5.8-.9z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /></svg>
          Find companies for my thesis
        </button>
      )}
      <div className={`thesis-collapse ${open ? 'open' : ''}`} aria-hidden={!open}>
        <div className="thesis-inner">
          <div className="thesis-card">
            <div className="thesis-head">
              <div>
                <div className="thesis-title">Find companies for my thesis</div>
                <div className="muted small">Describe what you invest in, pick your fund, or both. We source six fits from Dealroom and skip what you already own.</div>
              </div>
              <button className="icon-btn thesis-close" onClick={() => setOpen(false)} aria-label="Close">
                <svg viewBox="0 0 24 24" width="16" height="16"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
              </button>
            </div>

            <label className="thesis-label" htmlFor="thesis-text">Describe your thesis</label>
            <textarea
              id="thesis-text"
              ref={areaRef}
              className="thesis-area"
              rows={3}
              placeholder="Seed-stage AI infrastructure in Europe, technical founders, < $5M raised"
              value={thesis}
              onChange={(e) => setThesis(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); find(); } }}
            />

            <div className="thesis-row">
              <div className="thesis-fund">
                <span className="thesis-label">Your fund <span className="muted">(optional)</span></span>
                {fund ? (
                  <span className="fund-chip">
                    <Monogram name={fund.name} image={fund.image} size={22} />
                    <span className="fund-chip-name">{fund.name}</span>
                    <button className="fund-chip-x" onClick={() => setFund(null)} aria-label={`Remove ${fund.name}`}>
                      <svg viewBox="0 0 24 24" width="12" height="12"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" /></svg>
                    </button>
                  </span>
                ) : (
                  <div className="fund-search">
                    <input
                      className="fund-input"
                      placeholder="Search your fund, e.g. LocalGlobe"
                      value={fq}
                      onChange={(e) => setFq(e.target.value)}
                      onKeyDown={onFundKey}
                      onFocus={() => fHits.length && setFOpen(true)}
                      onBlur={() => setTimeout(() => setFOpen(false), 150)}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    {fOpen && fHits.length > 0 && (
                      <ul className="dropdown fund-dd" role="listbox">
                        {fHits.map((h, i) => (
                          <li key={h.uuid} role="option" aria-selected={i === fActive} className={`dd-row ${i === fActive ? 'active' : ''}`}
                            onMouseEnter={() => setFActive(i)} onMouseDown={(e) => { e.preventDefault(); pickFund(h); }}>
                            <Monogram name={h.name} image={h.image} size={30} />
                            <div className="dd-main"><div className="dd-name">{h.name}</div>{h.tagline && <div className="dd-tagline">{h.tagline}</div>}</div>
                          </li>
                        ))}
                      </ul>
                    )}
                    {fOpen && fq.trim().length >= 2 && fHits.length === 0 && <div className="dropdown dropdown-empty fund-dd">No investors match "{fq.trim()}"</div>}
                  </div>
                )}
              </div>
              <button className="btn btn-primary thesis-go" onClick={find} disabled={!canRun}>
                {loading ? <><span className="spinner spinner-xs thesis-go-spin" /> Sourcing...</> : 'Find companies'}
              </button>
            </div>
          </div>

          {loading && (
            <div className="thesis-results" aria-live="polite">
              <div className="thesis-status"><span className="pulse" /><span key={step} className="thesis-status-text">{STATUS[step]}</span></div>
              <div className="sugg-grid">
                {Array.from({ length: 6 }, (_, i) => (
                  <div key={i} className="sugg-card sugg-sk" style={{ animationDelay: `${i * 60}ms` }}>
                    <div className="sugg-top"><i className="sk-block sk-logo" /><div className="sugg-id"><i className="sk-block sk-l1" /><i className="sk-block sk-l2" /></div></div>
                    <i className="sk-block sk-l3" /><i className="sk-block sk-l4" />
                  </div>
                ))}
              </div>
            </div>
          )}

          {!loading && result && result.suggestions.length > 0 && (
            <div className="thesis-results">
              {result.thesisSummary && <p className="thesis-summary">{result.thesisSummary}</p>}
              <div className="sugg-grid">
                {result.suggestions.map((s, i) => (
                  <button key={s.uuid} className={`sugg-card ${building === s.uuid ? 'building' : ''}`} style={{ animationDelay: `${i * 60}ms` }}
                    onClick={() => build(s)} disabled={!!building}>
                    <div className="sugg-top">
                      <Monogram name={s.name} image={s.image} size={42} />
                      <div className="sugg-id">
                        <div className="sugg-name">{s.name}</div>
                        <div className="sugg-meta">{[hqOf(s), s.lastRound].filter(Boolean).join(' - ') || (s.tagline ?? '')}</div>
                      </div>
                    </div>
                    <p className="sugg-why">{s.why}</p>
                    <span className="sugg-cta">{building === s.uuid ? <><span className="spinner spinner-xs" /> Building deck...</> : 'Build deck'}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {error && !loading && <p className="error-line thesis-error">{error}</p>}
        </div>
      </div>
    </div>
  );
}
