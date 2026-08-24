const OWNER='shawnmccort';
const REPO='usfcph-week2';
const TCG_URL='https://www.pokemoncenter.com/category/tcg-cards';
const QUEUE_HOSTS=['pokemoncenter','pokemon','tpci'];
const POLL_MS=10_000;
const SECONDARY_MS=60_000;
const HEARTBEAT_MS=60_000;
const REMIND_MS=15*60_000;
const RUN_MS=5*60*60*1000+45*60*1000;
const ONCE=process.env.QUEUE_WATCH_ONCE==='1';
const TEST_NTFY=process.env.QUEUE_NTFY_TEST==='1';
const GH='https://api.github.com';
const token=process.env.GITHUB_TOKEN;
const sha=process.env.GITHUB_SHA;
if(!token)throw new Error('GITHUB_TOKEN missing');

const headers={'authorization':`Bearer ${token}`,'accept':'application/vnd.github+json','x-github-api-version':'2022-11-28','user-agent':'pokemon-drop-radar-queue-watch'};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function probe(url,{manual=false}={}){
  const ctrl=new AbortController();
  const timer=setTimeout(()=>ctrl.abort(),5000);
  try{
    const res=await fetch(url,{redirect:manual?'manual':'follow',signal:ctrl.signal,headers:{'user-agent':'Mozilla/5.0 (compatible; PokemonDropRadar/1.0; personal queue availability monitor)','accept-language':'en-US,en;q=0.9'}});
    const text=await res.text().catch(()=> '');
    return{url,status:res.status,location:res.headers.get('location'),finalUrl:res.url,text:text.slice(0,100000)};
  }catch(e){return{url,status:null,error:String(e?.message||e)}}
  finally{clearTimeout(timer)}
}
function eventIdFrom(s=''){try{const u=new URL(s);return u.searchParams.get('e')||u.searchParams.get('eventId')||u.pathname.match(/\/event\/([^/?#]+)/i)?.[1]||null}catch{return null}}
function looksLive(x){if(!x||x.status!==200)return false;const t=String(x.text||'').toLowerCase();return (t.includes('queue-it')||t.includes('queueit'))&&/waiting room|you are now in line|estimated wait|queue number|your place in line|waiting time/i.test(t)}
function looksBlocked(x){const t=String(x?.text||'').toLowerCase();return /pardon our interruption|imperva|incapsula|captcha|access denied|verify (that )?you are human|unusual traffic/i.test(t)}

async function detect(doSecondary){
  const tcg=await probe(TCG_URL,{manual:true});
  if(tcg.status&&tcg.status>=300&&tcg.status<400&&/queue-it\.net/i.test(tcg.location||'')){
    const url=new URL(tcg.location,TCG_URL).toString();
    return{active:true,status:'ACTIVE',signal:'tcg_category_redirect',queueUrl:url,eventId:eventIdFrom(url),primaryStatus:tcg.status};
  }
  if(doSecondary){
    const qs=await Promise.all(QUEUE_HOSTS.map(id=>probe(`https://${id}.queue-it.net/`)));
    for(const x of qs){
      if(!looksLive(x))continue;
      const t=String(x.text||'');
      if(!/(pok[eé]mon\s*(tcg|trading card)|trading card|booster|elite trainer|etb)/i.test(t))continue;
      const url=x.finalUrl||x.url;
      return{active:true,status:'ACTIVE',signal:'tcg_queue_page',queueUrl:url,eventId:eventIdFrom(url),primaryStatus:tcg.status};
    }
  }
  if(tcg.status===null)return{active:false,status:'ERROR',signal:null,queueUrl:TCG_URL,eventId:null,primaryStatus:null};
  if(looksBlocked(tcg))return{active:false,status:'BLOCKED',signal:null,queueUrl:TCG_URL,eventId:null,primaryStatus:tcg.status};
  return{active:false,status:'CLEAR',signal:null,queueUrl:TCG_URL,eventId:null,primaryStatus:tcg.status};
}

async function gh(path,opts={}){const res=await fetch(`${GH}${path}`,{...opts,headers:{...headers,...(opts.headers||{})}});if(!res.ok)throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0,200)}`);if(res.status===204)return null;return res.json()}
async function postStatus(context,state,description){if(!sha)return;try{await gh(`/repos/${OWNER}/${REPO}/statuses/${sha}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({state,context,description:String(description).slice(0,140)})})}catch(e){console.log('Status update unavailable',context,String(e?.message||e))}}
async function openAlertIssue(){try{const q=encodeURIComponent(`repo:${OWNER}/${REPO} is:issue is:open label:pokemon-queue-live`);const data=await gh(`/search/issues?q=${q}`);return data.items?.[0]||null}catch{return null}}
async function ensureLabel(){const res=await fetch(`${GH}/repos/${OWNER}/${REPO}/labels/pokemon-queue-live`,{headers});if(res.ok)return;await fetch(`${GH}/repos/${OWNER}/${REPO}/labels`,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({name:'pokemon-queue-live',color:'d73a4a',description:'Live Pokemon Center TCG queue alert'})}).catch(()=>{})}
async function createAlert(found){await ensureLabel();return gh(`/repos/${OWNER}/${REPO}/issues`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'🚨 Pokémon Center TCG queue is LIVE',body:[`@${OWNER} — Pokémon Center is routing the TCG path into a queue.`,``,`**Open now:** ${found.queueUrl||TCG_URL}`,found.eventId?`**Event:** ${found.eventId}`:'',`**Detected:** ${new Date().toISOString()}`].filter(Boolean).join('\n'),assignees:[OWNER],labels:['pokemon-queue-live']})})}
async function closeAlert(issue){try{await gh(`/repos/${OWNER}/${REPO}/issues/${issue.number}/comments`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({body:`Queue no longer detected as of ${new Date().toISOString()}. Closing this alert.`})});await gh(`/repos/${OWNER}/${REPO}/issues/${issue.number}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({state:'closed',state_reason:'completed'})})}catch(e){console.log('Issue close unavailable',String(e?.message||e))}}
async function sendNtfy({title,message,priority,tags,click}){
  const topic=process.env.NTFY_TOPIC;
  if(!topic)return false;
  const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),6000);
  try{
    const res=await fetch('https://ntfy.sh',{method:'POST',signal:ctrl.signal,headers:{'content-type':'application/json'},body:JSON.stringify({topic,title,message,priority,tags,click})});
    if(!res.ok){console.log('ntfy send failed',res.status);return false}
    return true;
  }catch(e){console.log('ntfy send error',String(e?.message||e));return false}
  finally{clearTimeout(timer)}
}
async function pushQueue(found,reminder=false){return sendNtfy({title:reminder?'⚡ Pokémon Center TCG queue still LIVE':'🚨 Pokémon Center TCG queue LIVE',message:reminder?'The TCG waiting room is still active. Open Pokémon Center now.':'Pokémon Center is routing TCG traffic into a waiting room. Open it now.',priority:5,tags:['zap','rotating_light'],click:found.queueUrl||TCG_URL})}

if(TEST_NTFY){
  const ok=await sendNtfy({title:'Pokémon Drop Radar test',message:'10-second Pokémon Center queue watcher is online. Real queue alerts will be urgent.',priority:3,tags:['test_tube','zap'],click:TCG_URL});
  await postStatus('pokemon-center-ntfy',ok?'success':'failure',ok?'ntfy startup test accepted':'ntfy topic missing or send failed');
  console.log('ntfy startup test',ok?'accepted':'FAILED');
}

let issue=await openAlertIssue();
let lastAlertAt=issue?Date.parse(issue.updated_at||issue.created_at||'')||null:null;
let lastSecondaryAt=0;
let lastHeartbeatAt=0;
let checks=0;
let errors=0;
let lastFound={active:false,status:'STARTING',signal:null,queueUrl:TCG_URL,eventId:null};
const end=Date.now()+RUN_MS;
console.log(ONCE?'Queue watcher preflight check':`Continuous queue watch started; polling primary every ${POLL_MS/1000}s until ${new Date(end).toISOString()}`);

if(!ONCE)await postStatus('pokemon-center-queue-watch','pending','10-second watcher starting');
do{
  const started=Date.now();
  try{
    const doSecondary=Date.now()-lastSecondaryAt>=SECONDARY_MS;
    const found=await detect(doSecondary);
    if(doSecondary)lastSecondaryAt=Date.now();
    lastFound=found;
    checks++;
    if(found.status==='ERROR')errors++;

    if(found.active){
      const reminder=lastAlertAt&&Date.now()-lastAlertAt>=REMIND_MS;
      if(!issue||reminder){
        const pushed=await pushQueue(found,Boolean(issue));
        console.log('QUEUE ACTIVE — ntfy',pushed?'sent':'topic unavailable/send failed',reminder?'reminder':'new queue');
        lastAlertAt=Date.now();
        if(!issue){try{issue=await createAlert(found);console.log('Backup GitHub issue created')}catch(e){console.log('Backup GitHub issue unavailable',String(e?.message||e))}}
      }
    }else if(issue){
      await closeAlert(issue);issue=null;lastAlertAt=null;
    }

    if(ONCE||checks===1||checks%6===0||found.active)console.log(new Date().toISOString(),found.active?'ACTIVE':found.status,found.signal||'',`checks=${checks}`,`errors=${errors}`);
  }catch(e){
    errors++;
    console.error(new Date().toISOString(),'queue check error',String(e?.message||e));
    if(ONCE)process.exitCode=1;
  }

  if(!ONCE&&Date.now()-lastHeartbeatAt>=HEARTBEAT_MS){
    const state=lastFound.active?'ACTIVE':lastFound.status;
    await postStatus('pokemon-center-queue-watch','pending',`10s watcher online; ${state}; checks=${checks}; errors=${errors}; ${new Date().toISOString()}`);
    lastHeartbeatAt=Date.now();
  }

  if(ONCE)break;
  await sleep(Math.max(0,POLL_MS-(Date.now()-started)));
}while(Date.now()<end);

if(ONCE){
  await postStatus('pokemon-center-preflight',process.exitCode?'failure':'success',`probe ${lastFound.status}; ${new Date().toISOString()}`);
  console.log('Queue watcher preflight complete');
}else{
  await postStatus('pokemon-center-queue-watch','success',`watch window complete; checks=${checks}; errors=${errors}`);
  console.log(`Queue watch window complete; checks=${checks}; errors=${errors}; next scheduled runner should take over.`);
}
