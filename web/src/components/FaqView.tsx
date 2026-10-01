import { useEffect, useState } from 'react';
import type { Deck } from '../../../shared/types';
import { Md } from './ChatDock';
import { bus } from '../lib/bus';

const CITE = /\[(r\d+(?:\s*,\s*r\d+)*)\]/g;

/** Markdown answer with [r3] / [r3, r5] tokens rendered as receipt chips. */
function Answer({ text, onCite }: { text: string; onCite: (r: string) => void }) {
  const out: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(CITE)) {
    if (m.index! > last) out.push(<Md key={`t${last}`} text={text.slice(last, m.index)} />);
    m[1].split(/\s*,\s*/).forEach((r) => out.push(
      <button key={`c${m.index}${r}`} className="fq-cite" onClick={() => onCite(r)} title={`Open receipt ${r}`}>{r}</button>,
    ));
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(<Md key={`t${last}`} text={text.slice(last)} />);
  return <div className="fq-a">{out}</div>;
}

/** Investor FAQ: question cards with cited markdown answers and a follow-up shortcut. */
export default function FaqView({ deck, onCite, onAsk }: { deck: Deck; onCite: (r: string) => void; onAsk: (q: string) => void }) {
  const faq = deck.faq || [];
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { if (deck.faq?.length) setPending(false); }, [deck.faq]);
  // A failed run reports via an error event; also never spin longer than 90s.
  useEffect(() => bus.on('error', () => setPending(false)), []);
  useEffect(() => {
    if (!pending) return;
    const t = window.setTimeout(() => { setPending(false); setErr('The FAQ is taking too long, try again.'); }, 90000);
    return () => clearTimeout(t);
  }, [pending]);

  const generate = async () => {
    setErr(null);
    setPending(true);
    const r = await fetch('/api/decks/' + deck.id + '/faq', { method: 'POST' }).catch(() => null);
    if (!r || !r.ok) { setPending(false); setErr(`Could not generate the FAQ${r ? ` (${r.status})` : ''}`); }
  };

  // Opening the tab on a ready deck without an FAQ starts writing it straight away (no button needed).
  useEffect(() => {
    if (!deck.faq?.length && deck.status === 'ready') void generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deck.id]);

  if (!faq.length) {
    return (
      <div className="fq-root">
        <div className="av-empty">
          {pending ? <><span className="spinner spinner-xs" /> Writing the investor FAQ from the receipts...</> : (
            <>
              <p className="av-empty-title">Investor FAQ</p>
              <p className="muted">{deck.status === 'building' ? 'The FAQ is written once the deck is ready.' : 'The sharp questions an IC would ask, answered with receipts.'}</p>
              {err && <p className="vx-err">{err}</p>}
              <button className="btn btn-primary" disabled={deck.status === 'building'} onClick={() => void generate()}>Generate FAQ</button>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="fq-root">
      <div className="fq-list">
        {faq.map((f, i) => (
          <details key={i + f.q} className="fq-card" open>
            <summary className="fq-q"><span className="fq-n">{i + 1}</span>{f.q}</summary>
            <Answer text={f.a} onCite={onCite} />
            <button className="fq-follow" onClick={() => onAsk(f.q)}>Ask a follow-up</button>
          </details>
        ))}
        <div className="fq-foot">
          <button className="btn" disabled={pending} onClick={() => void generate()}>{pending ? 'Regenerating...' : 'Regenerate FAQ'}</button>
        </div>
      </div>
    </div>
  );
}
