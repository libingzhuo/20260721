const $ = (id) => document.getElementById(id);
const video = $('video');
let sessionSeconds = 0, totalSeconds = 0, lastTick = performance.now(), lastSaved = 0;
let connectedCase = null, lastSyncSeconds = 0, syncBusy = false, pauseTimer = null, analysis = null;
let sourceKey = 'lesson:unset';
function addLog(action,message,bad=false){const box=$('sessionLog');if(box.children.length===1&&box.textContent.includes('等待操作'))box.innerHTML='';const row=document.createElement('div');if(bad)row.className='bad';const now=new Date().toLocaleTimeString('zh-CN',{hour12:false});row.innerHTML=`<time>${now}</time><b>${escapeHtml(action)}</b><span>${escapeHtml(message)}</span>`;box.prepend(row);}
$('clearLog').onclick=()=>{$('sessionLog').innerHTML='<div><time>刚刚</time><b>系统</b><span>日志已清空；账号密码从不写入日志。</span></div>';};

const fmt = (seconds) => {
  seconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60), s = seconds % 60;
  return h ? [h,m,s].map(x=>String(x).padStart(2,'0')).join(':') : [m,s].map(x=>String(x).padStart(2,'0')).join(':');
};
const fmtLong = (seconds) => `${Math.floor(seconds/3600)}小时${Math.floor(seconds%3600/60)}分${Math.floor(seconds%60)}秒`;
const toast = (message, bad=false) => { const el=$('toast'); el.textContent=message; el.style.background=bad?'#8a2d24':''; el.classList.add('show'); clearTimeout(el.t); el.t=setTimeout(()=>el.classList.remove('show'),3200); };
const isActive = () => !video.paused && !video.ended && document.visibilityState === 'visible' && document.hasFocus();
const ratio = () => Number.isFinite(video.duration) && video.duration > 0 ? Math.min(1, video.currentTime/video.duration) : 1;

function storageKey(){ return 'case-learning-v1:' + sourceKey; }
function saveState(){
  const state={position:video.currentTime||0,totalSeconds,lessonTitle:$('lessonTitle').value,transcript:$('transcript').value,lastSyncSeconds,updatedAt:new Date().toISOString()};
  localStorage.setItem(storageKey(),JSON.stringify(state)); $('saveState').textContent='已自动保存'; lastSaved=performance.now();
}
function restoreState(){
  const raw=localStorage.getItem(storageKey()); if(!raw) return;
  try { const s=JSON.parse(raw); totalSeconds=Number(s.totalSeconds)||0; lastSyncSeconds=Number(s.lastSyncSeconds)||0; $('lessonTitle').value=s.lessonTitle||''; $('transcript').value=s.transcript||'';
    video.addEventListener('loadedmetadata',()=>{ if(s.position<video.duration) video.currentTime=s.position; },{once:true}); toast(`已恢复上次进度 ${fmt(s.position)}`); } catch(_){}
}
function loadSource(src,key){ video.pause(); video.src=src; sourceKey=key; sessionSeconds=0; totalSeconds=0; lastSyncSeconds=0; analysis=null; restoreState(); video.load(); }

async function isHevc(file){const scan=async blob=>{const bytes=new Uint8Array(await blob.arrayBuffer());let s='';for(let i=0;i<bytes.length;i++)s+=String.fromCharCode(bytes[i]);return s.includes('hvc1')||s.includes('hev1')};const size=Math.min(file.size,4*1024*1024);return await scan(file.slice(0,size))||(file.size>size&&await scan(file.slice(-size)));}
async function prepareVideoFile(f){
  if(!$('lessonTitle').value)$('lessonTitle').value=f.name.replace(/\.[^.]+$/,'');
  const ext=(f.name.split('.').pop()||'').toLowerCase(),native=['mp4','webm','ogg','m4v'].includes(ext),hevc=await isHevc(f);
  if(native&&!hevc){loadSource(URL.createObjectURL(f),`file:${f.name}:${f.size}:${f.lastModified}`);addLog('视频','已载入 '+f.name);return;}
  toast(`检测到 ${hevc?'H.265':'非网页原生'} 视频，正在转换为 H.264…`);$('trackingBadge').textContent='正在转换';addLog('转码','开始处理 '+f.name);
  try{const base=location.protocol==='file:'?'http://127.0.0.1:8765':'';const r=await fetch(base+'/api/media/convert',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:f});if(!r.ok){let d=await r.json().catch(()=>({}));throw Error(d.error||'转换失败')}const blob=await r.blob();loadSource(URL.createObjectURL(blob),`h264:${f.name}:${f.size}:${f.lastModified}`);$('trackingBadge').textContent='转换完成';toast('视频已转换为 H.264，可以正常播放');addLog('转码','转换完成：'+f.name);}catch(e){$('trackingBadge').textContent='格式不兼容';addLog('转码失败',e.message,true);toast(location.protocol==='file:'?'请先运行 start.ps1，再重新选择附件进行自动转换':e.message,true);}
}
$('videoFile').addEventListener('change',e=>{const f=e.target.files[0];if(f)prepareVideoFile(f);});
const dropZone=$('dropZone');
['dragenter','dragover'].forEach(name=>dropZone.addEventListener(name,e=>{e.preventDefault();dropZone.classList.add('over');}));
['dragleave','drop'].forEach(name=>dropZone.addEventListener(name,e=>{e.preventDefault();dropZone.classList.remove('over');}));
dropZone.addEventListener('drop',e=>{const f=[...e.dataTransfer.files].find(x=>x.type.startsWith('video/'));if(!f)return toast('请拖入视频格式的 Case 附件',true);prepareVideoFile(f);});
$('loadUrl').onclick=()=>{ const u=$('videoUrl').value.trim(); if(!/^https?:\/\//i.test(u))return toast('请输入有效的 http/https 视频直链',true); loadSource(u,`url:${u}`); };

video.addEventListener('timeupdate',()=>{ $('positionText').textContent=`${fmt(video.currentTime)} / ${fmt(video.duration)}`; $('progressBar').style.width=`${ratio()*100}%`; });
video.addEventListener('play',()=>{ clearTimeout(pauseTimer); $('trackingBadge').textContent='正在计时'; $('trackingBadge').classList.remove('muted'); });
video.addEventListener('pause',()=>{ $('trackingBadge').textContent='已暂停'; pauseTimer=setTimeout(()=>{ if(sessionSeconds>lastSyncSeconds) autoSync('暂停超过30秒'); },30000); saveState(); });
video.addEventListener('ended',()=>autoSync('本次视频播放完成'));
document.addEventListener('visibilitychange',()=>{ if(document.hidden) saveState(); });

setInterval(()=>{
  const now=performance.now(), delta=Math.min(2,(now-lastTick)/1000); lastTick=now;
  if(isActive()){ sessionSeconds+=delta; totalSeconds+=delta; $('focusText').textContent='页面在前台 · 有效计时中'; }
  else $('focusText').textContent=video.paused?'视频已暂停':'页面不在前台 · 暂停计时';
  $('effectiveTime').textContent=fmt(totalSeconds).padStart(8,'0');
  if(now-lastSaved>15000)saveState();
  const mins=Number($('syncMinutes').value); if(mins&&totalSeconds-lastSyncSeconds>=mins*60)autoSync(`已累计学习${mins}分钟`);
},1000);

function localAnalyze(text,learnedRatio){const all=text.split(/[。！？；\n]+/).map(x=>x.trim()).filter(x=>x.length>=6);if(!all.length)throw Error('请先粘贴至少一段字幕或讲义文本');const n=Math.max(1,Math.round(all.length*Math.max(.01,Math.min(1,learnedRatio)))),learned=all.slice(0,n),keys=[];learned.forEach(x=>x.split(/需要|必须|应当|应该|可以|包括|通过|以及|并且|同时/).forEach(y=>{y=y.trim();if(y.length>=2&&y.length<=10&&!keys.includes(y))keys.push(y)}));const summary=learned.slice(0,5),quiz=summary.map((x,i)=>({type:'简答题',question:`请复述第 ${i+1} 个学习要点。`,answer:x}));return{ok:true,summary,keywords:keys.slice(0,8),quiz,coveredSentences:n,totalSentences:all.length};}
async function api(path,body){const cloud=location.protocol==='https:'&&!['127.0.0.1','localhost'].includes(location.hostname);if(cloud&&path==='/api/analyze')return localAnalyze(body.text,body.learnedRatio);if(cloud&&path.startsWith('/api/case/'))throw Error('云端静态版可进行视频学习与内容分析；Case 连接和回写需要本机完整版');const base=location.protocol==='file:'?'http://127.0.0.1:8765':'';try{const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||'请求失败');return d;}catch(e){if(location.protocol==='file:'&&String(e.message).includes('fetch'))throw new Error('单文件的 Case 连接需要先运行学习系统服务；本地视频学习不受影响');throw e;} }
const credentials=()=>({account:$('account').value.trim(),password:$('password').value,caseIndex:$('caseIndex').value.trim()});
$('connectCase').onclick=async()=>{ try{$('connectCase').disabled=true;addLog('登录','正在验证 Case 账号与 case#'+$('caseIndex').value);const d=await api('/api/case/check',credentials());connectedCase=d;$('caseTitle').textContent=`case#${$('caseIndex').value} · ${d.title}`;$('caseBadge').textContent='已连接';$('caseBadge').classList.remove('muted');$('syncNow').disabled=false;renderCaseUrls(d.learningUrls||[]);addLog('登录成功',`case#${$('caseIndex').value} · ${d.title}`);toast(`Case 连接成功，找到 ${d.learningUrls?.length||0} 个网址`);}catch(e){connectedCase=null;$('caseUrlSelect').innerHTML='<option value="">连接失败，请检查账号和 Case 编号</option>';$('loadCaseUrl').disabled=true;$('openCaseUrl').disabled=true;$('urlHint').textContent='成功连接 Case 后，学习网址会显示在这里。';addLog('登录失败',e.message,true);toast(e.message,true)}finally{$('connectCase').disabled=false;} };

function renderCaseUrls(urls){
  const box=$('caseUrls'), select=$('caseUrlSelect');
  box.hidden=false;
  if(!urls.length){select.innerHTML='<option value="">未在概述或评论中找到网址</option>';$('loadCaseUrl').disabled=true;$('openCaseUrl').disabled=true;$('urlHint').textContent='请先在 Case 概述或评论中添加 http/https 学习网址。';return;}
  select.innerHTML=urls.map((item,i)=>`<option value="${i}">${escapeHtml(item.source)} · ${escapeHtml(item.url)}</option>`).join('');
  $('loadCaseUrl').disabled=false;$('openCaseUrl').disabled=false;updateUrlHint();
}
function selectedCaseUrl(){return (connectedCase?.learningUrls||[])[Number($('caseUrlSelect').value)]||null;}
function updateUrlHint(){const item=selectedCaseUrl();$('urlHint').textContent=item?.directVideo?'已识别为视频直链，可在播放器内跟踪。':'这是普通网页链接；可以打开原网页，但第一版无法读取网页内部播放状态。';}
$('caseUrlSelect').addEventListener('change',updateUrlHint);
$('loadCaseUrl').onclick=()=>{const item=selectedCaseUrl();if(!item)return;if(!item.directVideo)return toast('该地址不是已识别的视频直链，请使用“打开原网页”',true);$('videoUrl').value=item.url;loadSource(item.url,`case-url:${item.url}`);if(!$('lessonTitle').value)$('lessonTitle').value=connectedCase.title;toast('已从 Case 载入学习视频');};
$('openCaseUrl').onclick=()=>{const item=selectedCaseUrl();if(item)window.open(item.url,'_blank','noopener,noreferrer');};

function buildComment(reason){
  const progress=Math.round(ratio()*100), title=$('lessonTitle').value.trim()||'未命名课程';
  const lines=[`【学习系统自动记录｜${reason}】`,`1. 课程：${title}`,`2. 本次有效学习：${fmtLong(sessionSeconds)}`,`3. 累计有效学习：${fmtLong(totalSeconds)}`,`4. 视频进度：${progress}%（${fmt(video.currentTime)} / ${fmt(video.duration)}）`,`5. 记录时间：${new Date().toLocaleString('zh-CN',{hour12:false})}`];
  if(analysis){ lines.push(`6. 已学习内容：${analysis.summary.join('；')}`); lines.push(`7. 关键词：${analysis.keywords.join('、')}`); lines.push(`8. 随堂练习：\n${analysis.quiz.map((q,i)=>`（${i+1}）${q.question}\n答案：${q.answer}`).join('\n')}`); }
  return lines.join('\n');
}
async function autoSync(reason){
  if(!connectedCase||syncBusy||totalSeconds<=lastSyncSeconds+2)return;
  syncBusy=true; try{const d=await api('/api/case/comment',{...credentials(),content:buildComment(reason)});lastSyncSeconds=totalSeconds;saveState();addLog('同步成功',`case#${$('caseIndex').value}${d.commentIndex?` · msg#${d.commentIndex}`:''}`);toast(`已同步到 Case${d.commentIndex?` · msg#${d.commentIndex}`:''}`);}catch(e){addLog('同步失败',e.message,true);toast(`自动同步失败：${e.message}`,true);}finally{syncBusy=false;}
}
$('syncNow').onclick=()=>autoSync('手动阶段同步');

$('analyze').onclick=async()=>{try{$('analyze').disabled=true;analysis=await api('/api/analyze',{text:$('transcript').value,learnedRatio:ratio()});$('emptyResult').hidden=true;$('results').hidden=false;$('summaryList').innerHTML=analysis.summary.map(x=>`<li>${escapeHtml(x)}</li>`).join('');$('keywordList').innerHTML=analysis.keywords.map(x=>`<span>${escapeHtml(x)}</span>`).join('');$('quizList').innerHTML=analysis.quiz.map((q,i)=>`<div class="quiz"><p>${i+1}. ${escapeHtml(q.question)}</p><span class="answer">答案：${escapeHtml(q.answer)}</span></div>`).join('');$('coverage').textContent=`已分析 ${analysis.coveredSentences}/${analysis.totalSentences} 段`;addLog('内容蒸馏',`已分析 ${analysis.coveredSentences}/${analysis.totalSentences} 段并生成 ${analysis.quiz.length} 道题`);toast('已按当前学习进度生成');}catch(e){addLog('分析失败',e.message,true);toast(e.message,true)}finally{$('analyze').disabled=false;}};
function escapeHtml(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML;}
window.addEventListener('beforeunload',saveState);

