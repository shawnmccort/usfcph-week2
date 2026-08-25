import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';

const OWNER='shawnmccort';
const REPO='usfcph-week2';
const BASE_BRANCH='master';
const STATE_BRANCH='pokemon-fast-state';
const STATE_PATH='pokemon-drop-radar/fast-state.json';
const ALERT_BRANCH='pokemon-fast-live-alert';
const ALERT_PATH='pokemon-drop-radar/FAST_LIVE.md';
const GH='https://api.github.com';
const RUN_MS=5*60*60*1000+45*60*1000;
const HEARTBEAT_MS=60_000;
const SAVE_MS=30_000;
const BLOCK_BACKOFF_MS=15*60_000;
const ONCE=process.env.FAST_WATCH_ONCE==='1';
const token=process.env.GITHUB_TOKEN;
const sha=process.env.GITHUB_SHA;
const ntfyTopic=process.env.NTFY_TOPIC||'';
const NTFY_SERVER=(process.env.NTFY_SERVER||'https://ntfy.sh').replace(/\/$/,'');
const SUPABASE_URL='https://avtjrtqzwjiefpowboqo.supabase.co';
const SUPABASE_KEY='sb_publishable_yPWA8Ghh-UpxNGt-wSVkvw_3sOkdFTr';
function easternClock(now=new Date()){
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(now).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
  return {year:Number(parts.year),month:Number(parts.month),day:Number(parts.day),hour:Number(parts.hour)};
}
function targetTonightOverride(product,now=new Date()){
  const t=easternClock(now);
  return product?.retailer==='Target'&&t.year===2026&&t.month===8&&t.day===25&&t.hour>=0&&t.hour<3;
}
function quietNow(product){
  const t=easternClock();
  if(targetTonightOverride(product))return false;
  return t.hour>=0&&t.hour<8;
}
async function sendNtfy(product,row){
  if(!ntfyTopic||quietNow(product))return false;
  const body={
    topic:ntfyTopic,
    title:`🚨 ${product.retailer}: ${product.name}`,
    message:[
      String(row.status||'').replaceAll('_',' ').toUpperCase(),
      row.price!=null?`$${Number(row.price).toFixed(2)} · max $${Number(product.maxPrice).toFixed(2)}`:`Max $${Number(product.maxPrice).toFixed(2)}`,
      product.sku?`SKU ${product.sku}`:'',
      row.lastEvidenceVerdict==='confirmed_2_of_2'?'CONFIRMED 2/2 independent reads':'Verified by the seconds-level Pokemon Drop Radar',
      'Verified by the seconds-level Pokemon Drop Radar'
    ].filter(Boolean).join('\n'),
    priority:targetTonightOverride(product)?5:4,
    tags:['rotating_light','card_index_dividers'],
    click:row.url||product.url
  };
  const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),6000);
  try{
    const res=await fetch(NTFY_SERVER,{method:'POST',signal:ctrl.signal,headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    if(!res.ok)throw new Error(`ntfy HTTP ${res.status}`);
    return true;
  }catch(e){console.log('ntfy send failed',String(e?.message||e));return false;}
  finally{clearTimeout(timer);}
}
async function publishRealtimeState(state){
  if(!ntfyTopic)return;
  const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),5000);
  try{
    const res=await fetch(`${SUPABASE_URL}/rest/v1/rpc/ingest_pokemon_fast_state`,{
      method:'POST',signal:ctrl.signal,
      headers:{'apikey':SUPABASE_KEY,'content-type':'application/json'},
      body:JSON.stringify({p_secret:ntfyTopic,p_state:state})
    });
    if(!res.ok)throw new Error(`Supabase realtime HTTP ${res.status}`);
  }catch(e){console.log('realtime state publish failed',String(e?.message||e));}
  finally{clearTimeout(timer);}
}
if(!token)throw new Error('GITHUB_TOKEN missing');

const cfg=JSON.parse(await fs.readFile('pokemon-drop-radar/fast-products.json','utf8'));
const products=cfg.products||[];
const intervals=cfg.retailerIntervalsMs||{};
const headers={'authorization':`Bearer ${token}`,'accept':'application/vnd.github+json','x-github-api-version':'2022-11-28','user-agent':'pokemon-fast-drop-watch'};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const ACTIONABLE=new Set(['in_stock','add_to_cart','preorder_open','reservation_open','invite_open','queue_open','drawing_open']);
const ACCESS=new Set(['reservation_open','invite_open','queue_open','drawing_open']);
const BLOCK_MARKERS=['are you a human','access denied','px-captcha','captcha-delivery','perimeterx','unusual traffic','please verify you are a human','akamai reference','request unsuccessful','incapsula','imperva'];

async function gh(path,opts={}){
  const res=await fetch(`${GH}${path}`,{...opts,headers:{...headers,...(opts.headers||{})}});
  if(!res.ok)throw new Error(`GitHub ${res.status}: ${(await res.text().catch(()=>'' )).slice(0,220)}`);
  if(res.status===204)return null;
  return res.json();
}
async function ghMaybe(path,opts={}){
  const res=await fetch(`${GH}${path}`,{...opts,headers:{...headers,...(opts.headers||{})}});
  if(res.status===404)return null;
  if(!res.ok)throw new Error(`GitHub ${res.status}: ${(await res.text().catch(()=>'' )).slice(0,220)}`);
  if(res.status===204)return null;
  return res.json();
}
async function postStatus(context,state,description){
  if(!sha)return;
  try{await gh(`/repos/${OWNER}/${REPO}/statuses/${sha}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({state,context,description:String(description).slice(0,140)})});}catch(e){console.log('status update failed',context,String(e?.message||e));}
}
async function deleteBranch(branch){try{await ghMaybe(`/repos/${OWNER}/${REPO}/git/refs/heads/${encodeURIComponent(branch)}`,{method:'DELETE'});}catch(e){console.log('branch cleanup failed',branch,String(e?.message||e));}}
async function ensureBranch(branch){
  const ref=await ghMaybe(`/repos/${OWNER}/${REPO}/git/ref/heads/${encodeURIComponent(branch)}`);
  if(ref)return;
  await gh(`/repos/${OWNER}/${REPO}/git/refs`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ref:`refs/heads/${branch}`,sha})});
}
async function readBranchJson(branch,path,fallback){
  const x=await ghMaybe(`/repos/${OWNER}/${REPO}/contents/${path}?ref=${encodeURIComponent(branch)}`);
  if(!x?.content)return fallback;
  try{return JSON.parse(Buffer.from(x.content.replace(/\n/g,''),'base64').toString('utf8'));}catch{return fallback;}
}
async function writeBranchText(branch,path,text,message){
  await ensureBranch(branch);
  const current=await ghMaybe(`/repos/${OWNER}/${REPO}/contents/${path}?ref=${encodeURIComponent(branch)}`);
  const body={message,content:Buffer.from(text).toString('base64'),branch};
  if(current?.sha)body.sha=current.sha;
  return gh(`/repos/${OWNER}/${REPO}/contents/${path}`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
}
async function loadState(){
  await ensureBranch(STATE_BRANCH);
  return readBranchJson(STATE_BRANCH,STATE_PATH,{version:1,updatedAt:null,products:{}});
}
async function saveState(state){
  state.updatedAt=new Date().toISOString();
  await publishRealtimeState(state);
  await writeBranchText(STATE_BRANCH,STATE_PATH,JSON.stringify(state,null,2)+'\n','Update fast Pokemon watcher state [skip ci]');
}

function blocked(html,status){
  if([403,429,503].includes(status))return true;
  const head=String(html||'').slice(0,45000).toLowerCase();
  return BLOCK_MARKERS.some(x=>head.includes(x));
}
async function getPage(url){
  const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),9000);
  try{
    const res=await fetch(url,{redirect:'follow',signal:ctrl.signal,headers:{'user-agent':'Mozilla/5.0 (compatible; PokemonDropRadar/1.0; personal availability monitor)','accept-language':'en-US,en;q=0.9','accept':'text/html,application/xhtml+xml'}});
    const text=await res.text().catch(()=> '');
    return {status:res.status,ok:res.ok,text,url:res.url};
  }catch(e){return{status:null,ok:false,text:'',error:String(e?.message||e)}}
  finally{clearTimeout(timer);}
}
const decode=s=>String(s||'').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;/gi,"'").replace(/&nbsp;/gi,' ');
const strip=html=>decode(String(html||'').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim());
const normalizeEscaped=raw=>String(raw||'').replace(/\\u0026/g,'&').replace(/\\u003c/gi,'<').replace(/\\u003e/gi,'>').replace(/\\"/g,'"').replace(/\\n/g,' ');

function bestBuySkuState(html,sku){
  const patterns=[`"skuId":"${sku}"`,`\\"skuId\\":\\"${sku}\\"`];
  const positions=[];
  for(const needle of patterns){
    let from=0;
    while(true){const i=html.indexOf(needle,from);if(i<0)break;positions.push(i);from=i+needle.length;}
  }
  positions.sort((a,b)=>a-b);
  for(const idx of positions){
    const ctx=normalizeEscaped(html.slice(Math.max(0,idx-500),Math.min(html.length,idx+9000)));
    const skuMark=`"skuId":"${sku}"`;
    const mark=ctx.indexOf(skuMark);
    const local=ctx.slice(Math.max(0,mark),Math.min(ctx.length,mark>=0?mark+7500:7500));
    const block=local.match(/"buttonStates"\s*:\s*\[([\s\S]{0,2600}?)\]/i)?.[1]||local;
    const state=block.match(/"buttonState"\s*:\s*"([A-Z0-9_-]+)"/i)?.[1];
    const text=block.match(/"displayText"\s*:\s*"([^"\n]{1,120})"/i)?.[1]||null;
    if(state)return{state:state.toUpperCase(),text,ctx:local};
  }
  return null;
}
function bestBuyStatus(found,product){
  if(!found)return null;
  const raw=found.state;
  if(raw==='COMING_SOON')return'coming_soon';
  if(['SOLD_OUT','OUT_OF_STOCK','UNAVAILABLE','NOT_AVAILABLE','DISABLED'].includes(raw))return'out_of_stock';
  if(['PREORDER','PRE_ORDER','PREORDER_AVAILABLE'].includes(raw))return'preorder_open';
  if(raw.includes('RESERV'))return'reservation_open';
  if(raw.includes('QUEUE')||raw.includes('LINE'))return'queue_open';
  if(raw.includes('DRAW'))return'drawing_open';
  if(raw.includes('INVITE'))return'invite_open';
  if(['ADD_TO_CART','BUY_NOW','AVAILABLE'].includes(raw)){
    if(product.bestBuyAccessMode==='invite')return'invite_open';
    if(product.bestBuyAccessMode==='reservation')return'reservation_open';
    return'add_to_cart';
  }
  return null;
}
function bestBuyPrice(ctx){
  const patterns=[
    /"currentPrice"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i,
    /"customerPrice"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i,
    /"price"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i,
    /\$([0-9]{1,4}(?:\.[0-9]{2}))/
  ];
  for(const p of patterns){const m=ctx.match(p);if(m){const n=Number(m[1]);if(Number.isFinite(n)&&n>0&&n<5000)return n;}}
  return null;
}
function bestBuySafeFallback(html){
  const visible=strip(html).toLowerCase();
  if(/\bcoming soon\b/.test(visible))return'coming_soon';
  if(/\bout of stock\b|\bsold out\b|\bcurrently unavailable\b/.test(visible))return'out_of_stock';
  return'unknown';
}
async function checkBestBuy(product){
  const page=await getPage(product.url);
  if(blocked(page.text,page.status))return{health:'blocked',http:page.status};
  if(!page.ok)return{health:'error',http:page.status,error:page.error||`HTTP ${page.status}`};
  const found=bestBuySkuState(page.text,product.sku);
  const status=bestBuyStatus(found,product)||bestBuySafeFallback(page.text);
  const price=bestBuyPrice(found?.ctx||'');
  const special=ACCESS.has(status);
  const under=price!=null&&price<=Number(product.maxPrice);
  return{health:'ok',status,price,isFirstParty:true,actionable:ACTIONABLE.has(status)&&(special||under),http:page.status};
}

function scopeAround(html,sku){
  const i=html.indexOf(String(sku));
  return i>=0?html.slice(Math.max(0,i-55000),Math.min(html.length,i+90000)):html.slice(0,140000);
}
function targetPrimary(html,product){
  const visible=strip(html),low=visible.toLowerCase(),name=String(product.name||'').toLowerCase();
  let start=name?low.indexOf(name):-1;
  if(start<0){const i=low.indexOf(`tcin: ${product.sku}`.toLowerCase());if(i>=0)start=Math.max(0,i-5000);}
  if(start<0)return{status:null,price:null};
  const block=visible.slice(start,start+7000),b=block.toLowerCase();
  const tcinIdx=b.indexOf(`tcin: ${product.sku}`.toLowerCase());
  const core=tcinIdx>=0?block.slice(0,tcinIdx+String(product.sku).length+6):block.slice(0,3500);
  const c=core.toLowerCase();
  const pm=core.match(/\$([0-9]{1,4}(?:\.[0-9]{2}))/);const price=pm?Number(pm[1]):null;
  let status=null;
  if(/\bout of stock\b|\bsold out\b|\bcurrently unavailable\b/.test(c))status='out_of_stock';
  else if(/\bcoming soon\b/.test(c))status='coming_soon';
  else if(/\bpre[- ]?order\b/.test(c))status='preorder_open';
  else if(/\badd to cart\b/.test(c))status='add_to_cart';
  return{status,price};
}
function targetSeller(scope){
  const text=strip(scope);
  const sold=text.match(/sold\s*(?:&|and)?\s*shipped by\s+([^|·\n]{2,80})/i)?.[1]?.trim();
  if(sold&&!/^target(?:\.com)?$/i.test(sold))return{seller:sold,isFirstParty:false};
  if(/target plus|third[- ]party seller|item ships from third party seller/i.test(text))return{seller:sold||'Target Plus partner',isFirstParty:false};
  return{seller:'Target',isFirstParty:true};
}
function targetStructured(scope,sku){
  const re=/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for(const m of scope.matchAll(re)){
    try{
      const root=JSON.parse(m[1]);const q=Array.isArray(root)?[...root]:[root];
      while(q.length){
        const x=q.shift();if(!x||typeof x!=='object')continue;
        if(Array.isArray(x['@graph']))q.push(...x['@graph']);
        if(Array.isArray(x.itemListElement))q.push(...x.itemListElement.map(y=>y?.item||y));
        const type=Array.isArray(x['@type'])?x['@type'].join(' '):String(x['@type']||'');
        if(!/product/i.test(type))continue;
        const ids=[x.sku,x.productID,x.mpn].filter(Boolean).map(String);
        if(ids.length&&!ids.some(v=>v.includes(String(sku))))continue;
        const offers=Array.isArray(x.offers)?x.offers:[x.offers].filter(Boolean);const o=offers[0];if(!o)continue;
        const price=Number(o.price??o.lowPrice);const av=String(o.availability||'').toLowerCase();
        const status=av.includes('instock')?'in_stock':av.includes('preorder')?'preorder_open':av.includes('outofstock')||av.includes('soldout')?'out_of_stock':null;
        return{status,price:Number.isFinite(price)&&price>0?price:null};
      }
    }catch{}
  }
  return{status:null,price:null};
}
async function checkTarget(product){
  const checkedAt=new Date().toISOString();
  const page=await getPage(product.url);
  if(blocked(page.text,page.status))return{health:'blocked',http:page.status,evidence:{checkedAt,http:page.status,health:'blocked'}};
  if(!page.ok)return{health:'error',http:page.status,error:page.error||`HTTP ${page.status}`,evidence:{checkedAt,http:page.status,health:'error'}};
  const scope=scopeAround(page.text,product.sku);const primary=targetPrimary(page.text,product);const structured=targetStructured(scope,product.sku);const seller=targetSeller(scope);
  const disagreement=ACTIONABLE.has(primary.status)&&structured.status==='out_of_stock';
  const status=disagreement?'unknown':(primary.status||structured.status||'unknown');const price=primary.price??structured.price??null;
  const under=price!=null&&price<=Number(product.maxPrice);
  const actionable=ACTIONABLE.has(status)&&seller.isFirstParty===true&&under;
  const evidence={
    checkedAt,http:page.status,finalUrl:page.url||product.url,bodyBytes:Buffer.byteLength(page.text||''),
    bodySha256:createHash('sha256').update(page.text||'').digest('hex'),
    primaryStatus:primary.status||null,structuredStatus:structured.status||null,
    primaryPrice:primary.price??null,structuredPrice:structured.price??null,
    seller:seller.seller,isFirstParty:seller.isFirstParty,disagreement,actionable
  };
  return{health:'ok',status,price,seller:seller.seller,isFirstParty:seller.isFirstParty,actionable,http:page.status,evidence};
}
async function checkTargetConfirmed(product){
  const first=await checkTarget(product);
  if(first.actionable!==true)return{...first,evidenceVerdict:first.evidence?.disagreement?'parser_disagreement':'not_actionable',evidenceProbes:[first.evidence].filter(Boolean)};
  await sleep(1500);
  const second=await checkTarget(product);
  const probes=[first.evidence,second.evidence].filter(Boolean);
  if(second.actionable!==true){
    return{...second,status:'unknown',actionable:false,evidenceVerdict:'failed_2_of_2_confirmation',evidenceProbes:probes};
  }
  return{...second,evidenceVerdict:'confirmed_2_of_2',evidenceProbes:probes};
}
async function checkProduct(product){return product.retailer==='Best Buy'?checkBestBuy(product):product.retailer==='Target'?checkTargetConfirmed(product):{health:'error',error:'unsupported retailer'};}

async function openAlertPr(){
  try{const pulls=await gh(`/repos/${OWNER}/${REPO}/pulls?state=open&head=${encodeURIComponent(`${OWNER}:${ALERT_BRANCH}`)}&per_page=5`);return pulls?.[0]||null;}catch{return null;}
}
function liveMarkdown(live){
  return ['# Pokémon fast drop alert','',`Updated: ${new Date().toISOString()}`,'',...live.map(x=>`- **${x.name}** — ${x.retailer}${x.price!=null?` — $${Number(x.price).toFixed(2)}`:''} — ${x.status}\n  ${x.url}`),''].join('\n');
}
async function requestReview(prNumber){try{await gh(`/repos/${OWNER}/${REPO}/pulls/${prNumber}/requested_reviewers`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({reviewers:[OWNER]})});}catch(e){console.log('review request failed',String(e?.message||e));}}
async function syncAlertPr(live,newItems=[]){
  let pr=await openAlertPr();
  if(!live.length){
    if(pr){try{await gh(`/repos/${OWNER}/${REPO}/pulls/${pr.number}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({state:'closed'})});}catch{} await deleteBranch(ALERT_BRANCH);}
    return;
  }
  if(!pr){
    await deleteBranch(ALERT_BRANCH);await ensureBranch(ALERT_BRANCH);
    await writeBranchText(ALERT_BRANCH,ALERT_PATH,liveMarkdown(live),'Record live Pokemon product drop');
    pr=await gh(`/repos/${OWNER}/${REPO}/pulls`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'🚨 Pokémon card drop LIVE',body:`@${OWNER} — fast watcher detected an eligible Pokémon product. Open the links in the changed file immediately.`,head:ALERT_BRANCH,base:BASE_BRANCH,maintainer_can_modify:true})});
    await requestReview(pr.number);
  }else{
    await writeBranchText(ALERT_BRANCH,ALERT_PATH,liveMarkdown(live),'Refresh live Pokemon product drop');
    if(newItems.length){
      const lines=newItems.map(x=>`- ${x.name} — ${x.retailer}${x.price!=null?` — $${Number(x.price).toFixed(2)}`:''} — ${x.url}`).join('\n');
      try{await gh(`/repos/${OWNER}/${REPO}/issues/${pr.number}/comments`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({body:`@${OWNER} — **new eligible drop detected:**\n${lines}`})});}catch(e){console.log('alert comment failed',String(e?.message||e));}
    }
  }
}

function applyObservation(prev,obs,product){
  const now=new Date().toISOString();
  // Never publish an actionable-looking status unless every verifier gate passed.
  const safeStatus=obs.actionable===true||!ACTIONABLE.has(obs.status)?obs.status:'unknown';
  if(!prev){
    if(obs.health!=='ok')return{next:{name:product.name,retailer:product.retailer,url:product.url,maxPrice:product.maxPrice,status:'unknown',price:null,actionable:false,health:obs.health,lastProbeAt:now,lastError:obs.error||null,http:obs.http??null,clearCandidateCount:0},transition:null};
    return{next:{name:product.name,retailer:product.retailer,url:product.url,maxPrice:product.maxPrice,status:safeStatus,price:obs.price??null,actionable:obs.actionable===true,health:'ok',lastProbeAt:now,lastVerifiedAt:now,lastError:null,http:obs.http??null,clearCandidateCount:0,lastEvidenceVerdict:obs.evidenceVerdict||null,lastEvidenceProbes:obs.evidenceProbes||null},transition:null};
  }
  if(obs.health!=='ok')return{next:{...prev,health:obs.health,lastProbeAt:now,lastError:obs.error||null,http:obs.http??null},transition:null};
  const base={...prev,health:'ok',lastProbeAt:now,lastVerifiedAt:now,lastError:null,http:obs.http??null,lastEvidenceVerdict:obs.evidenceVerdict||null,lastEvidenceProbes:obs.evidenceProbes||null};
  if(prev.actionable===true&&obs.actionable!==true){
    const same=prev.clearCandidateStatus===safeStatus;const count=same?Number(prev.clearCandidateCount||0)+1:1;
    if(count<2)return{next:{...base,clearCandidateStatus:safeStatus,clearCandidatePrice:obs.price??null,clearCandidateCount:count},transition:null};
    return{next:{...base,status:safeStatus,price:obs.price??null,actionable:false,clearCandidateStatus:null,clearCandidatePrice:null,clearCandidateCount:0,lastClearEvidence:{at:now,verdict:obs.evidenceVerdict||null,probes:obs.evidenceProbes||null}},transition:'cleared'};
  }
  const became=prev.actionable!==true&&obs.actionable===true;
  return{next:{...base,status:safeStatus,price:obs.price??null,actionable:obs.actionable===true,clearCandidateStatus:null,clearCandidatePrice:null,clearCandidateCount:0,...(became?{lastLiveEvidence:{at:now,verdict:obs.evidenceVerdict||null,probes:obs.evidenceProbes||null}}:{})},transition:became?'new':null};
}

async function preflight(){
  const samples=[];
  for(const retailer of ['Best Buy','Target']){
    const p=products.find(x=>x.retailer===retailer);if(!p)continue;
    const r=await checkProduct(p);samples.push(`${retailer}=${r.health}${r.status?`/${r.status}`:''}`);
  }
  await postStatus('pokemon-fast-preflight','success',samples.join('; ')||'no samples');
  console.log('fast watcher preflight',samples.join(' | '));
}

if(ONCE){await preflight();process.exit(0);}

let state=await loadState();state.products=state.products||{};
const retailerBackoff=new Map();
const due=new Map();
const now=Date.now();
for(const retailer of [...new Set(products.map(p=>p.retailer))]){
  const group=products.filter(p=>p.retailer===retailer);const interval=Number(intervals[retailer]||180000);const step=Math.max(3000,Math.floor(interval/group.length));
  group.forEach((p,i)=>due.set(p.key,now+i*step));
}
let checks=0,errors=0,blockedChecks=0,lastHeartbeat=0,lastSave=0;
const end=Date.now()+RUN_MS;
await postStatus('pokemon-fast-drop-watch','pending',`fast watcher starting; ${products.length} products`);
console.log(`Fast product watcher online: ${products.length} products until ${new Date(end).toISOString()}`);

while(Date.now()<end){
  let product=null,nextAt=Infinity;
  for(const p of products){const t=due.get(p.key)||0;if(t<nextAt){nextAt=t;product=p;}}
  if(!product)break;
  if(nextAt>Date.now()){await sleep(Math.min(5000,nextAt-Date.now()));continue;}
  const backed=retailerBackoff.get(product.retailer)||0;
  if(backed>Date.now()){due.set(product.key,backed+Math.floor(Math.random()*5000));continue;}

  const started=Date.now();
  const obs=await checkProduct(product);checks++;
  if(obs.health==='blocked'){blockedChecks++;retailerBackoff.set(product.retailer,Date.now()+BLOCK_BACKOFF_MS);}
  else if(obs.health==='error')errors++;
  const prev=state.products[product.key]||null;const {next,transition}=applyObservation(prev,obs,product);state.products[product.key]=next;
  // Direct ntfy path: send once per verified live cycle. Overnight hits are
  // deferred and sent after 08:00 Eastern only if the listing is still live.
  if(next.actionable===true&&ntfyTopic){
    if(next.ntfySentForLive!==true){
      if(quietNow(product)){
        next.ntfyPending=true;
      }else{
        const sentNow=await sendNtfy(product,next);
        if(sentNow){next.ntfySentForLive=true;next.ntfyPending=false;}
      }
    }
  }else if(transition==='cleared'){
    next.ntfySentForLive=false;
    next.ntfyPending=false;
  }
  const interval=Number(intervals[product.retailer]||180000);due.set(product.key,started+interval);

  if(transition){
    const live=Object.entries(state.products).filter(([,x])=>x.actionable===true).map(([key,x])=>({key,...x}));
    if(transition==='new')await syncAlertPr(live,[{key:product.key,...next}]);
    else if(transition==='cleared')await syncAlertPr(live,[]);
    await saveState(state);lastSave=Date.now();
    console.log(new Date().toISOString(),transition.toUpperCase(),product.retailer,product.name,next.status,next.price??'');
  }else if(checks===1||checks%10===0){
    console.log(new Date().toISOString(),product.retailer,product.name,obs.health,obs.status||'',`checks=${checks}`);
  }

  if(Date.now()-lastSave>=SAVE_MS){await saveState(state);lastSave=Date.now();}
  if(Date.now()-lastHeartbeat>=HEARTBEAT_MS){
    const live=Object.values(state.products).filter(x=>x.actionable===true).length;
    await postStatus('pokemon-fast-drop-watch','pending',`online; checks=${checks}; live=${live}; blocked=${blockedChecks}; errors=${errors}; ${new Date().toISOString()}`);
    lastHeartbeat=Date.now();
  }
}

await saveState(state);
await postStatus('pokemon-fast-drop-watch','success',`window complete; checks=${checks}; blocked=${blockedChecks}; errors=${errors}`);
console.log(`Fast watcher window complete: checks=${checks} blocked=${blockedChecks} errors=${errors}`);
