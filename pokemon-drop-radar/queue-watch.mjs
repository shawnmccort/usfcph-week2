const OWNER='shawnmccort';
const REPO='usfcph-week2';
const TCG_URL='https://www.pokemoncenter.com/category/tcg-cards';
const QUEUE_HOSTS=['pokemoncenter','pokemon','tpci'];
const POLL_MS=60_000;
const RUN_MS=5*60*60*1000+45*60*1000;
const ONCE=process.env.QUEUE_WATCH_ONCE==='1';
const GH='https://api.github.com';
const token=process.env.GITHUB_TOKEN;
if(!token)throw new Error('GITHUB_TOKEN missing');

const headers={'authorization':`Bearer ${token}`,'accept':'application/vnd.github+json','x-github-api-version':'2022-11-28','user-agent':'pokemon-drop-radar-queue-watch'};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function probe(url,{manual=false}={}){
  const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),5000);
  try{const res=await fetch(url,{redirect:manual?'manual':'follow',signal:ctrl.signal,headers:{'user-agent':'Mozilla/5.0 (compatible; PokemonDropRadar/1.0; queue availability monitor)','accept-language':'en-US,en;q=0.9'}});const text=await res.text().catch(()=> '');return{url,status:res.status,location:res.headers.get('location'),finalUrl:res.url,text:text.slice(0,100000)};}catch(e){return{url,status:null,error:String(e?.message||e)}}finally{clearTimeout(timer)}
}
function eventIdFrom(s=''){try{const u=new URL(s);return u.searchParams.get('e')||u.searchParams.get('eventId')||u.pathname.match(/\/event\/([^/?#]+)/i)?.[1]||null}catch{return null}}
function looksLive(x){if(!x||x.status!==200)return false;const t=String(x.text||'').toLowerCase();return (t.includes('queue-it')||t.includes('queueit'))&&/waiting room|you are now in line|estimated wait|queue number|your place in line|waiting time/i.test(t)}

async function detect(){
  const tcg=await probe(TCG_URL,{manual:true});
  if(tcg.status>=300&&tcg.status<400&&/queue-it\.net/i.test(tcg.location||'')){
    const url=new URL(tcg.location,TCG_URL).toString();return{active:true,signal:'tcg_category_redirect',queueUrl:url,eventId:eventIdFrom(url)};
  }
  const qs=await Promise.all(QUEUE_HOSTS.map(id=>probe(`https://${id}.queue-it.net/`)));
  for(const x of qs){if(!looksLive(x))continue;const t=String(x.text||'');if(!/(pok[eé]mon\s*(tcg|trading card)|trading card|booster|elite trainer|etb)/i.test(t))continue;return{active:true,signal:'tcg_queue_page',queueUrl:x.finalUrl||x.url,eventId:eventIdFrom(x.finalUrl||x.url)}}
  return{active:false,signal:null,queueUrl:TCG_URL,eventId:null};
}

async function gh(path,opts={}){const res=await fetch(`${GH}${path}`,{...opts,headers:{...headers,...(opts.headers||{})}});if(!res.ok)throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0,200)}`);if(res.status===204)return null;return res.json()}
async function openAlertIssue(){try{const q=encodeURIComponent(`repo:${OWNER}/${REPO} is:issue is:open label:pokemon-queue-live`);const data=await gh(`/search/issues?q=${q}`);return data.items?.[0]||null}catch{return null}}
async function ensureLabel(){const res=await fetch(`${GH}/repos/${OWNER}/${REPO}/labels/pokemon-queue-live`,{headers});if(res.ok)return;await fetch(`${GH}/repos/${OWNER}/${REPO}/labels`,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({name:'pokemon-queue-live',color:'d73a4a',description:'Live Pokemon Center TCG queue alert'})}).catch(()=>{});}
async function createAlert(found){await ensureLabel();return gh(`/repos/${OWNER}/${REPO}/issues`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'🚨 Pokémon Center TCG queue is LIVE',body:[`@${OWNER} — Pokémon Center is routing the TCG path into a queue.`,``,`**Open now:** ${found.queueUrl||TCG_URL}`,found.eventId?`**Event:** ${found.eventId}`:'',`**Detected:** ${new Date().toISOString()}`].filter(Boolean).join('\n'),assignees:[OWNER],labels:['pokemon-queue-live']})});}
async function closeAlert(issue){try{await gh(`/repos/${OWNER}/${REPO}/issues/${issue.number}/comments`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({body:`Queue no longer detected as of ${new Date().toISOString()}. Closing this alert.`})});await gh(`/repos/${OWNER}/${REPO}/issues/${issue.number}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({state:'closed',state_reason:'completed'})});}catch(e){console.log('Issue close unavailable',String(e?.message||e))}}
async function optionalNtfy(found){const topic=process.env.NTFY_TOPIC;if(!topic||!found.active)return false;const res=await fetch('https://ntfy.sh',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({topic,title:'⚡ Pokémon Center TCG queue LIVE',message:'Open Pokémon Center now to join the TCG waiting room.',priority:5,tags:['zap','rotating_light'],click:found.queueUrl||TCG_URL})});if(!res.ok){console.log('ntfy send failed',res.status);return false}return true;}

let previousActive=null;
const end=Date.now()+RUN_MS;
console.log(ONCE?'Queue watcher preflight check':`Continuous queue watch started; polling every ${POLL_MS/1000}s until ${new Date(end).toISOString()}`);
do{
  try{
    const found=await detect();
    const issue=await openAlertIssue();
    if(found.active&&previousActive!==true){
      const pushed=await optionalNtfy(found);
      console.log('QUEUE ACTIVE — immediate ntfy attempt',pushed?'sent':'topic unavailable');
      if(!issue){try{await createAlert(found);console.log('Backup GitHub issue created')}catch(e){console.log('Backup GitHub issue unavailable',String(e?.message||e))}}
    }else if(!found.active&&issue){await closeAlert(issue);}
    previousActive=found.active;
    console.log(new Date().toISOString(),found.active?'ACTIVE':'clear',found.signal||'');
  }catch(e){console.error(new Date().toISOString(),'queue check error',String(e?.message||e));if(ONCE)process.exitCode=1;}
  if(ONCE)break;
  await sleep(POLL_MS);
}while(Date.now()<end);
console.log(ONCE?'Queue watcher preflight complete':'Queue watch window complete; next scheduled runner should take over.');
