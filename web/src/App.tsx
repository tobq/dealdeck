import { useEffect, useState } from 'react';
import Landing from './pages/Landing';
import DeckPage from './pages/DeckPage';
import { api, navigate } from './lib/api';

function usePath(): string {
  const [path, setPath] = useState(() => location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  return path;
}

// One import per path even if the component remounts.
const imports = new Map<string, Promise<{ id: string }>>();

function ImportRoute({ path }: { path: string }) {
  const [error, setError] = useState<string | null>(null);
  const target = decodeURIComponent(path.slice(1));
  useEffect(() => {
    let live = true;
    if (!imports.has(path)) imports.set(path, api.importUrl(target));
    imports.get(path)!.then(({ id }) => { if (live) navigate(`/d/${id}`, true); }).catch((e) => {
      imports.delete(path);
      if (live) setError(String(e?.message || e));
    });
    return () => { live = false; };
  }, [path, target]);
  return (
    <div className="center-screen">
      <a className="brand brand-lg" href="/" onClick={(e) => { e.preventDefault(); navigate('/'); }}>
        <span className="brand-mark" />Dealdeck
      </a>
      {error ? (
        <>
          <p className="import-title">Could not import that link</p>
          <p className="muted import-sub">{error}</p>
          <button className="btn btn-primary" onClick={() => navigate('/')}>Search instead</button>
        </>
      ) : (
        <>
          <div className="spinner" />
          <p className="import-title">Importing...</p>
          <p className="muted import-sub">{target}</p>
        </>
      )}
    </div>
  );
}

export default function App() {
  const path = usePath();
  useEffect(() => { window.scrollTo(0, 0); }, [path]);
  if (path === '/' || path === '') return <Landing />;
  const m = path.match(/^\/d\/([^/]+)\/?$/);
  if (m) return <DeckPage key={m[1]} id={decodeURIComponent(m[1])} />;
  return <ImportRoute path={path} />;
}
