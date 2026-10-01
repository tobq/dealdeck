// Renders any Slide kind on a fixed 1600x900 canvas scaled to its container (keynote-accurate at any size).
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, Tooltip, XAxis, YAxis } from 'recharts';
import type { Deck, Slide } from '../../../shared/types';

const W = 1600;
const H = 900;
const ACCENT = '#3b5bfd';
const SERIES = [ACCENT, '#0f172a', '#14b8a6', '#f59e0b', '#ef4444', '#8b5cf6'];

type CiteFn = ((receiptId: string) => void) | undefined;

function Cites({ ids, onCite }: { ids?: string[]; onCite: CiteFn }) {
  if (!ids || !ids.length) return null;
  return (
    <span className="cites">
      {ids.map((r) => (
        <button
          key={r}
          className="cite"
          tabIndex={onCite ? 0 : -1}
          onClick={(e) => { e.stopPropagation(); onCite?.(r); }}
          title={onCite ? `Open receipt ${r}` : r}
        >
          {r}
        </button>
      ))}
    </span>
  );
}

function Mono({ name, image, size }: { name: string; image?: string | null; size: number }) {
  const [broken, setBroken] = useState(false);
  if (image && !broken) return <img className="sv-avatar" src={image} alt="" style={{ width: size, height: size }} onError={() => setBroken(true)} />;
  const letters = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
  return <span className="sv-avatar sv-mono" style={{ width: size, height: size, fontSize: size * 0.36 }}>{letters}</span>;
}

/** Shrink type as content grows so dense slides still fit the canvas. */
function fit(n: number, big: number, small: number, from = 4, to = 10) {
  if (n <= from) return big;
  if (n >= to) return small;
  return Math.round(big - ((n - from) / (to - from)) * (big - small));
}

function TitleSlide({ slide, deck, onCite }: { slide: Slide; deck: Deck; onCite: CiteFn }) {
  const img = slide.image || deck.coverImage || null;
  return (
    <div className={`sv-title ${img ? 'has-img' : ''}`}>
      {img && <div className="sv-cover" style={{ backgroundImage: `url(${img})` }} />}
      {img && <div className="sv-scrim" />}
      <div className="sv-title-inner">
        <div className="sv-entity">
          <Mono name={deck.entity.name} image={deck.entity.image} size={64} />
          <span>{deck.entity.kind === 'investor' ? 'Fund review' : 'Investment memo'}</span>
        </div>
        <h1 className="sv-h1">{slide.title}</h1>
        {slide.subtitle && <p className="sv-sub">{slide.subtitle}</p>}
        {slide.bullets && slide.bullets.length > 0 && (
          <div className="sv-title-bullets">
            {slide.bullets.slice(0, 4).map((b, i) => <span key={i}>{b.text}<Cites ids={b.receipts} onCite={onCite} /></span>)}
          </div>
        )}
        {slide.metrics && slide.metrics.length > 0 && (
          <div className="sv-title-metrics">
            {slide.metrics.slice(0, 4).map((m, i) => (
              <div key={i}><b>{m.value}<Cites ids={m.receipts} onCite={onCite} /></b><span>{m.label}</span></div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Metrics({ slide, onCite }: { slide: Slide; onCite: CiteFn }) {
  const ms = slide.metrics || [];
  const cols = ms.length <= 2 ? ms.length || 1 : ms.length === 4 ? 2 : ms.length <= 6 ? 3 : 4;
  const size = fit(ms.length, 96, 56, 3, 8);
  return (
    <div className="sv-metrics" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
      {ms.map((m, i) => (
        <div className="sv-metric" key={i}>
          <div className="sv-metric-value" style={{ fontSize: size }}>{m.value}<Cites ids={m.receipts} onCite={onCite} /></div>
          <div className="sv-metric-label">{m.label}</div>
          {m.note && <div className="sv-metric-note">{m.note}</div>}
        </div>
      ))}
    </div>
  );
}

function Bullets({ items, onCite, numbered }: { items: Array<{ text: string; receipts?: string[] }>; onCite: CiteFn; numbered?: boolean }) {
  const size = fit(items.length, 38, 26, 4, 9);
  return (
    <ol className={`sv-bullets ${numbered ? 'numbered' : ''}`} style={{ fontSize: size }}>
      {items.map((b, i) => (
        <li key={i}>
          <span className="sv-bullet-mark">{numbered ? String(i + 1).padStart(2, '0') : ''}</span>
          <span className="sv-bullet-text">{b.text}<Cites ids={b.receipts} onCite={onCite} /></span>
        </li>
      ))}
    </ol>
  );
}

function fmtNum(v: number, unit?: string) {
  const abs = Math.abs(v);
  const s = abs >= 1e9 ? `${+(v / 1e9).toFixed(1)}B` : abs >= 1e6 ? `${+(v / 1e6).toFixed(1)}M` : abs >= 1e3 ? `${+(v / 1e3).toFixed(1)}K` : `${+v.toFixed(2)}`;
  if (!unit) return s;
  if (unit === '$' || unit === '€' || unit === '£') return unit + s;
  if (unit === '%') return s + '%';
  return s;
}

function ChartBody({ slide, onCite, animate }: { slide: Slide; onCite: CiteFn; animate: boolean }) {
  const chart = slide.chart!;
  const { rows, names } = useMemo(() => {
    const order: string[] = [];
    const map = new Map<string, Record<string, number | string>>();
    for (const s of chart.series || []) {
      for (const p of s.points || []) {
        if (!map.has(p.x)) { map.set(p.x, { x: p.x }); order.push(p.x); }
        map.get(p.x)![s.name] = Number(p.y);
      }
    }
    return { rows: order.map((x) => map.get(x)!), names: (chart.series || []).map((s) => s.name) };
  }, [chart]);
  const multi = names.length > 1;
  const cw = 1440;
  const ch = slide.subtitle ? 560 : 610;
  const axis = { tick: { fill: '#64748b', fontSize: 22 }, axisLine: { stroke: '#e2e8f0' }, tickLine: false };
  const yFmt = (v: number) => fmtNum(v, chart.unit);
  return (
    <div className="sv-chart">
      <div className="sv-chart-meta">
        {chart.yLabel && <span>{chart.yLabel}{chart.unit && !chart.yLabel.includes(chart.unit) ? ` (${chart.unit})` : ''}</span>}
        <Cites ids={chart.receipts} onCite={onCite} />
      </div>
      {chart.type === 'line' ? (
        <LineChart width={cw} height={ch} data={rows} margin={{ top: 16, right: 32, left: 16, bottom: 8 }}>
          <CartesianGrid stroke="#eef2f7" vertical={false} />
          <XAxis dataKey="x" {...axis} dy={10} />
          <YAxis {...axis} tickFormatter={yFmt} width={110} />
          <Tooltip formatter={(v: any) => yFmt(Number(v))} contentStyle={{ fontSize: 20, borderRadius: 12 }} />
          {multi && <Legend wrapperStyle={{ fontSize: 22 }} />}
          {names.map((n, i) => (
            <Line key={n} type="monotone" dataKey={n} stroke={SERIES[i % SERIES.length]} strokeWidth={5} dot={{ r: 6, strokeWidth: 0, fill: SERIES[i % SERIES.length] }} isAnimationActive={animate} connectNulls />
          ))}
        </LineChart>
      ) : (
        <BarChart width={cw} height={ch} data={rows} margin={{ top: 16, right: 32, left: 16, bottom: 8 }} barCategoryGap="22%">
          <CartesianGrid stroke="#eef2f7" vertical={false} />
          <XAxis dataKey="x" {...axis} dy={10} interval={0} />
          <YAxis {...axis} tickFormatter={yFmt} width={110} />
          <Tooltip cursor={{ fill: 'rgba(59,91,253,0.06)' }} formatter={(v: any) => yFmt(Number(v))} contentStyle={{ fontSize: 20, borderRadius: 12 }} />
          {multi && <Legend wrapperStyle={{ fontSize: 22 }} />}
          {names.map((n, i) => (
            <Bar key={n} dataKey={n} fill={SERIES[i % SERIES.length]} radius={[8, 8, 0, 0]} isAnimationActive={animate} maxBarSize={120} />
          ))}
        </BarChart>
      )}
    </div>
  );
}

function TableBody({ slide, onCite }: { slide: Slide; onCite: CiteFn }) {
  const t = slide.table!;
  const size = fit(t.rows.length, 28, 19, 5, 12);
  return (
    <div className="sv-table-wrap">
      <table className="sv-table" style={{ fontSize: size }}>
        <thead><tr>{t.columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
        <tbody>
          {t.rows.map((r, i) => (
            <tr key={i}>
              {r.cells.map((c, j) => (
                <td key={j}>{c}{j === r.cells.length - 1 && <Cites ids={r.receipts} onCite={onCite} />}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function People({ slide, onCite }: { slide: Slide; onCite: CiteFn }) {
  const ps = slide.people || [];
  const cols = ps.length <= 3 ? Math.max(ps.length, 1) : ps.length === 4 ? 2 : 3;
  const avatar = ps.length <= 3 ? 120 : 88;
  return (
    <div className="sv-people" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
      {ps.map((p, i) => (
        <div className="sv-person" key={i}>
          <Mono name={p.name} image={p.image} size={avatar} />
          <div className="sv-person-text">
            <div className="sv-person-name">{p.name}<Cites ids={p.receipts} onCite={onCite} /></div>
            <div className="sv-person-role">{p.role}</div>
            {p.blurb && <div className="sv-person-blurb">{p.blurb}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

function Compare({ slide, onCite }: { slide: Slide; onCite: CiteFn }) {
  const c = slide.compare!;
  const tone = (h: string, side: 'left' | 'right') => {
    const s = h.toLowerCase();
    if (/bull|upside|strength|pro\b|pros|for\b|opportunit/.test(s)) return 'bull';
    if (/bear|downside|risk|weak|con\b|cons|against|concern/.test(s)) return 'bear';
    return side === 'left' ? 'neutral-a' : 'neutral-b';
  };
  const n = Math.max(c.left.points.length, c.right.points.length);
  const size = fit(n, 30, 22, 3, 7);
  return (
    <div className="sv-compare">
      {(['left', 'right'] as const).map((side) => {
        const col = c[side];
        return (
          <div key={side} className={`sv-col sv-col-${tone(col.heading, side)}`}>
            <div className="sv-col-head">{col.heading}</div>
            <ul style={{ fontSize: size }}>
              {col.points.map((p, i) => <li key={i}>{p.text}<Cites ids={p.receipts} onCite={onCite} /></li>)}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function Body({ slide, onCite, animate }: { slide: Slide; onCite: CiteFn; animate: boolean }) {
  const k = slide.kind;
  if (k === 'metrics' && slide.metrics?.length) return <Metrics slide={slide} onCite={onCite} />;
  if (k === 'chart' && slide.chart?.series?.length) return <ChartBody slide={slide} onCite={onCite} animate={animate} />;
  if (k === 'table' && slide.table?.rows?.length) return <TableBody slide={slide} onCite={onCite} />;
  if (k === 'people' && slide.people?.length) return <People slide={slide} onCite={onCite} />;
  if (k === 'compare' && slide.compare) return <Compare slide={slide} onCite={onCite} />;
  if (k === 'questions' && slide.bullets?.length) return <Bullets items={slide.bullets} onCite={onCite} numbered />;
  if (k === 'bullets' && slide.bullets?.length) return <Bullets items={slide.bullets} onCite={onCite} />;
  // Kind/data mismatch: render whatever the slide actually carries.
  if (slide.metrics?.length) return <Metrics slide={slide} onCite={onCite} />;
  if (slide.chart?.series?.length) return <ChartBody slide={slide} onCite={onCite} animate={animate} />;
  if (slide.table?.rows?.length) return <TableBody slide={slide} onCite={onCite} />;
  if (slide.people?.length) return <People slide={slide} onCite={onCite} />;
  if (slide.compare) return <Compare slide={slide} onCite={onCite} />;
  if (slide.bullets?.length) return <Bullets items={slide.bullets} onCite={onCite} numbered={k === 'questions'} />;
  return null;
}

export default function SlideView({ slide, deck, onCite, thumb = false }: { slide: Slide; deck: Deck; onCite?: (receiptId: string) => void; thumb?: boolean }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setScale(el.clientWidth / W);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const cite = thumb ? undefined : onCite;
  const isTitle = slide.kind === 'title';
  return (
    <div className={`slide-box ${thumb ? 'is-thumb' : ''}`} ref={boxRef}>
      <div className="slide-canvas" style={{ width: W, height: H, transform: `scale(${scale})`, visibility: scale ? 'visible' : 'hidden' }}>
        {isTitle ? (
          <TitleSlide slide={slide} deck={deck} onCite={cite} />
        ) : (
          <div className={`sv sv-kind-${slide.kind}`}>
            <div className="sv-head">
              <h2 className="sv-h2">{slide.title}</h2>
              {slide.subtitle && <p className="sv-sub2">{slide.subtitle}</p>}
            </div>
            <div className="sv-body"><Body slide={slide} onCite={cite} animate={!thumb} /></div>
            <div className="sv-foot">
              <span className="sv-foot-brand"><i />{deck.entity.name}</span>
              <span>Dealdeck</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
