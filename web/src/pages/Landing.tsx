import { useEffect, useRef, useState } from 'react';
import type { Deck, SearchHit } from '../../../shared/types';
import { api, createDeckByName, createDeckFromHit, navigate } from '../lib/api';

const EXAMPLES = ['Synthesia', 'Wayve', 'LocalGlobe'];

export function Monogram({ name, size = 36, image, className = '' }: { name: string; size?: number; image?: string | null; className?: string }) {
  const [broken, setBroken] = useState(false);
  const letters = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
  if (image && !broken) {
    return <img className={`logo ${className}`} src={image} alt="" width={size} height={size} style={{ width: size, height: size }} onError={() => setBroken(true)} />;
  }
  return <span className={`logo monogram ${className}`} style={{ width: size, height: size, fontSize: size * 0.38 }}>{letters}</span>;
}

function hq(h: SearchHit) {
  return [h.hqCity, h.hqCountry].filter(Boolean).join(', ');
}

export default function Landing() {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<Deck[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => { api.recent().then(setRecent).catch(() => setRecent([])); }, []);
  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { abortRef.current?.abort(); setHits([]); setLoading(false); return; }
    setLoading(true);
    const t = setTimeout(() => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      api.search(term, ac.signal)
        .then((res) => {
          if (ac.signal.aborted) return;
          setHits(res.filter((h) => h.type === 'company' || h.type === 'investor').slice(0, 8));
          setActive(0);
          setOpen(true);
          setLoading(false);
        })
        .catch((e) => { if (!ac.signal.aborted) { setLoading(false); setError(String(e.message || e)); } });
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  async function run(label: string, fn: () => Promise<string>) {
    setCreating(label);
    setError(null);
    try {
      const id = await fn();
      navigate(`/d/${id}`);
    } catch (e: any) {
      setError(String(e?.message || e));
      setCreating(null);
    }
  }

  const pick = (h: SearchHit) => { setOpen(false); run(h.name, () => createDeckFromHit(h)); };

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, hits.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (open && hits[active]) pick(hits[active]);
      else if (q.trim()) run(q.trim(), () => createDeckByName(q.trim()));
    } else if (e.key === 'Escape') setOpen(false);
  }

  return (
    <div className="landing">
      <header className="landing-top">
        <a className="brand" href="/" onClick={(e) => { e.preventDefault(); navigate('/'); }}><span className="brand-mark" />Dealdeck</a>
        <span className="muted small">Live data from Dealroom</span>
      </header>

      <main className="landing-main">
        <h1 className="hero-title">Dealdeck</h1>
        <p className="hero-tagline">Any company or fund, as an investor deck, in seconds.</p>

        <div className={`search ${open && hits.length ? 'search-open' : ''}`}>
          <svg className="search-icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
            <path d="M20 20l-4.2-4.2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            className="search-input"
            placeholder="Search a company or investor..."
            value={q}
            disabled={!!creating}
            onChange={(e) => { setQ(e.target.value); setError(null); }}
            onKeyDown={onKey}
            onFocus={() => hits.length && setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            role="combobox"
            aria-expanded={open}
            aria-controls="search-results"
            autoComplete="off"
            spellCheck={false}
          />
          {(loading || creating) && <span className="spinner spinner-sm search-spin" />}
          {open && hits.length > 0 && (
            <ul className="dropdown" id="search-results" role="listbox">
              {hits.map((h, i) => (
                <li
                  key={h.uuid}
                  role="option"
                  aria-selected={i === active}
                  className={`dd-row ${i === active ? 'active' : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => { e.preventDefault(); pick(h); }}
                >
                  <Monogram name={h.name} image={h.image} size={40} />
                  <div className="dd-main">
                    <div className="dd-name">
                      {h.name}
                      <span className={`badge badge-${h.type}`}>{h.type === 'investor' ? 'Investor' : 'Company'}</span>
                      {h.isUnicorn ? <span className="badge badge-unicorn">Unicorn</span> : null}
                    </div>
                    {h.tagline && <div className="dd-tagline">{h.tagline}</div>}
                  </div>
                  {hq(h) && <div className="dd-hq">{hq(h)}</div>}
                </li>
              ))}
            </ul>
          )}
          {open && !loading && q.trim().length >= 2 && hits.length === 0 && (
            <div className="dropdown dropdown-empty">No companies or investors match "{q.trim()}"</div>
          )}
        </div>

        {creating ? (
          <p className="creating"><span className="spinner spinner-sm" /> Building a deck for <b>{creating}</b>...</p>
        ) : (
          <div className="chips">
            <span className="muted small">Try</span>
            {EXAMPLES.map((name) => (
              <button key={name} className="chip" onClick={() => run(name, () => createDeckByName(name))}>{name}</button>
            ))}
          </div>
        )}
        {error && <p className="error-line">{error}</p>}
      </main>

      {recent.length > 0 && (
        <section className="recent">
          <div className="recent-head">Recent decks</div>
          <div className="recent-row">
            {recent.map((d) => (
              <a key={d.id} className="recent-card" href={`/d/${d.id}`} onClick={(e) => { e.preventDefault(); navigate(`/d/${d.id}`); }}>
                <div className="recent-thumb" style={d.coverImage ? { backgroundImage: `url(${d.coverImage})` } : undefined}>
                  {!d.coverImage && <Monogram name={d.entity.name} image={d.entity.image} size={44} />}
                </div>
                <div className="recent-meta">
                  <div className="recent-title">{d.title || d.entity.name}</div>
                  <div className="muted small">{d.entity.kind === 'investor' ? 'Investor' : 'Company'} - {d.slides.length} slides</div>
                </div>
              </a>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
