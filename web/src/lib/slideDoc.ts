// Wraps an expressive-mode slide fragment (Slide.html) into a full 1920x1080 document for an iframe srcdoc.
// Base stylesheet = the deck design system (Inter, accent, ink/muted/line, good/bad); the fragment may
// override anything with its own <style>. Clicking any [data-r] element posts {type:'cite', r} to the parent;
// {type:'ready'} is posted on load. Rendered with sandbox="allow-scripts" (opaque origin), so postMessage
// targets '*' and the parent must check event.source.

const BASE_CSS = `
:root{--accent:#3b5bfd;--ink:#0b1020;--muted:#5b6475;--line:#e6e8ee;--bg:#ffffff;--good:#12a150;--bad:#d93b3b;
--font:'Inter',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}
*,*::before,*::after{box-sizing:border-box}
html,body{width:1920px;height:1080px;margin:0;padding:0;overflow:hidden}
body{background:var(--bg);color:var(--ink);font-family:var(--font);font-size:32px;line-height:1.4;
-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;font-feature-settings:'tnum' 1,'cv11' 1}
h1,h2,h3,h4{margin:0;color:var(--ink);font-weight:800;letter-spacing:-0.03em;line-height:1.05}
h1{font-size:104px}
h2{font-size:68px;font-weight:750}
h3{font-size:42px;font-weight:700;letter-spacing:-0.02em}
h4{font-size:30px;font-weight:700;letter-spacing:-0.01em}
p{margin:0 0 .6em;color:var(--muted)}
ul,ol{margin:0;padding-left:1.1em}
li{margin:0 0 .45em}
strong,b{color:var(--ink);font-weight:700}
small{font-size:22px;color:var(--muted)}
table{width:100%;border-collapse:collapse;font-size:28px}
th{text-align:left;font-size:20px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);
padding:14px 20px;border-bottom:2px solid var(--line)}
td{padding:18px 20px;border-bottom:1px solid var(--line);vertical-align:top}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
svg{display:block;max-width:100%;overflow:visible}
svg text{font-family:var(--font)}
img{max-width:100%;display:block}
canvas{max-width:100%}
.pad{width:1920px;height:1080px;padding:96px 120px}
.muted{color:var(--muted)}
.accent{color:var(--accent)}
.good{color:var(--good)}
.bad{color:var(--bad)}
.cite{display:inline-block;vertical-align:super;margin-left:6px;padding:3px 10px;border-radius:999px;
font-size:18px!important;font-weight:700;line-height:1.2;letter-spacing:0;color:var(--accent);
background:rgba(59,91,253,.1);cursor:pointer;user-select:none;text-decoration:none;white-space:nowrap}
.cite:hover{background:var(--accent);color:#fff}
[data-r]{cursor:pointer}
`;

const BRIDGE = `(function(){
function post(m){try{parent.postMessage(m,'*')}catch(e){}}
document.addEventListener('click',function(e){
var t=e.target&&e.target.closest?e.target.closest('[data-r]'):null;
if(!t)return;var r=(t.getAttribute('data-r')||'').split(/[\\s,]+/).filter(Boolean)[0];
if(r){e.preventDefault();e.stopPropagation();post({type:'cite',r:r})}
},true);
window.addEventListener('load',function(){post({type:'ready'});
try{document.fonts.ready.then(function(){if(C&&C.instances)Object.values(C.instances).forEach(function(c){c.update()})})}catch(e){}});
var C;try{Object.defineProperty(window,'Chart',{configurable:true,get:function(){return C},set:function(v){C=v;try{
var d=v.defaults;d.font.family="'Inter',system-ui,sans-serif";d.font.size=24;d.color='#5b6475';d.borderColor='#e6e8ee';
d.animation.duration=600;d.plugins.legend.labels.boxWidth=18}catch(e){}}})}catch(e){}
})();`;

export function slideDoc(html: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=1920,height=1080">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
<style>${BASE_CSS}</style>
<script>${BRIDGE}</script>
</head><body>
${html}
</body></html>`;
}
