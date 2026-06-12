pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const EN=(document.documentElement.lang||'').toLowerCase().startsWith('en');

/* ═══════════════════════════ TABS ═══════════════════════════ */
function switchTab(t){
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c=>c.classList.remove('active'));
  document.getElementById('tabBtn'+t.toUpperCase()).classList.add('active');
  document.getElementById('tab'+t.toUpperCase()).classList.add('active');
  if(t==='c'){
    // compress tab: correction is the whole point → ensure it's on and visible
    document.getElementById('corrToggle').checked=true;
    document.getElementById('corrBody').classList.add('open');
    document.getElementById('corrOptimize').checked=true;
    document.getElementById('corrOptSub').classList.add('open');
  }
}

/* ═══════════════════════════ SHARED UTILS ═══════════════════════════ */
const SKEW_WARN=1.0, SKEW_ERR=2.5;

async function renderPageToCanvas(doc,pageNum,targetWidth){
  const page=await doc.getPage(pageNum);
  const vp0=page.getViewport({scale:1});
  const scale=targetWidth/vp0.width;
  const vp=page.getViewport({scale});
  const c=document.createElement('canvas');
  c.width=Math.round(vp.width); c.height=Math.round(vp.height);
  await page.render({canvasContext:c.getContext('2d'),viewport:vp}).promise;
  return c;
}

function detectSkewAngle(canvas){
  const W=canvas.width,H=canvas.height;
  const ctx=canvas.getContext('2d');
  const data=ctx.getImageData(0,0,W,H).data;
  const gray=new Uint8Array(W*H);
  const hist=new Int32Array(256);
  for(let i=0;i<W*H;i++){const g=Math.round(.299*data[i*4]+.587*data[i*4+1]+.114*data[i*4+2]);gray[i]=g;hist[g]++;}
  const total=W*H;
  let sum=0;for(let i=0;i<256;i++)sum+=i*hist[i];
  let sumB=0,wB=0,wF=0,maxV=0,thresh=128;
  for(let t=0;t<256;t++){wB+=hist[t];if(!wB)continue;wF=total-wB;if(!wF)break;sumB+=t*hist[t];const mB=sumB/wB,mF=(sum-sumB)/wF,v=wB*wF*(mB-mF)**2;if(v>maxV){maxV=v;thresh=t;}}
  const bin=new Uint8Array(W*H);
  for(let i=0;i<W*H;i++)bin[i]=gray[i]<thresh?1:0;
  const x0=Math.round(W*.2),x1=Math.round(W*.8),y0=Math.round(H*.1),y1=Math.round(H*.9);
  const cX=W/2,cY=H/2;
  let bestA=0,bestV=-1;
  for(let deg=-5;deg<=5;deg+=.25){
    const rad=deg*Math.PI/180,cosA=Math.cos(rad),sinA=Math.sin(rad);
    const rc=new Int32Array(H);
    for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
      if(!bin[y*W+x])continue;
      const ry=Math.round((y-cY)*cosA-(x-cX)*sinA+cY);
      if(ry>=0&&ry<H)rc[ry]++;
    }
    let s=0,s2=0,n=y1-y0;
    for(let y=y0;y<y1;y++){s+=rc[y];s2+=rc[y]**2;}
    const v=s2/n-(s/n)**2;
    if(v>bestV){bestV=v;bestA=deg;}
  }
  return Math.round(bestA*10)/10;
}

/* ─ Shared lightbox ─ */
let lbDoc=null,lbPage=1,lbSrcMap=[],lbSkewMap=[],lbBusy=false,lbQueued=null;
const lbEl=document.getElementById('lightbox');
const lbWrap=document.getElementById('lbWrap');
const lbSpinner=document.getElementById('lbSpinner');
const lbPrevBtn=document.getElementById('lbPrev');
const lbNextBtn=document.getElementById('lbNext');
const lbInfo=document.getElementById('lbInfo');
const lbSrcEl=document.getElementById('lbSrc');
const lbSkewEl=document.getElementById('lbSkew');

function openLightbox(doc,page,srcMap,skewMap){
  lbDoc=doc;lbSrcMap=srcMap||[];lbSkewMap=skewMap||[];
  lbPage=page;
  lbEl.classList.add('open');
  document.body.style.overflow='hidden';
  renderLB(page);
}
function closeLB(){lbEl.classList.remove('open');document.body.style.overflow='';}
async function renderLB(p){
  if(lbBusy){lbQueued=p;return;}lbBusy=true;
  lbInfo.textContent=`${p} / ${lbDoc.numPages}`;
  lbPrevBtn.disabled=p<=1;lbNextBtn.disabled=p>=lbDoc.numPages;
  const src=lbSrcMap[p-1]||'';
  lbSrcEl.className='lb-badge '+(src||'');
  lbSrcEl.textContent=src==='odd'?(EN?'Front':'앞면'):src==='even'?(EN?'Back':'뒷면'):src||'';
  lbSrcEl.style.display=src?'inline-block':'none';
  const sr=lbSkewMap[p-1];
  if(sr&&sr.level!=='ok'){
    lbSkewEl.className=`lb-badge lb-skew ${sr.level}`;
    lbSkewEl.textContent=`${EN?'Skew ':'기울기 '}${sr.angle>=0?'+':''}${sr.angle.toFixed(1)}°`;
    lbSkewEl.style.display='inline-block';
  }else{lbSkewEl.style.display='none';}
  lbWrap.innerHTML='';lbWrap.appendChild(lbSpinner);lbSpinner.style.display='flex';
  try{
    const maxW=Math.min(window.innerWidth*.82,860);
    const c=await renderPageToCanvas(lbDoc,p,maxW);
    lbWrap.innerHTML='';lbWrap.appendChild(c);
  }catch{lbWrap.innerHTML=(EN?'<div class="lb-spinner">Render failed</div>':'<div class="lb-spinner">렌더링 실패</div>');}
  lbBusy=false;
  if(lbQueued!==null){const n=lbQueued;lbQueued=null;lbPage=n;await renderLB(n);}
}
document.getElementById('lbClose').addEventListener('click',closeLB);
lbEl.addEventListener('click',e=>{if(e.target===lbEl)closeLB();});
lbPrevBtn.addEventListener('click',()=>{if(lbPage>1){lbPage--;renderLB(lbPage);}});
lbNextBtn.addEventListener('click',()=>{if(lbDoc&&lbPage<lbDoc.numPages){lbPage++;renderLB(lbPage);}});
document.addEventListener('keydown',e=>{
  if(!lbEl.classList.contains('open'))return;
  if(e.key==='Escape')closeLB();
  if(e.key==='ArrowLeft'&&lbPage>1){lbPage--;renderLB(lbPage);}
  if(e.key==='ArrowRight'&&lbDoc&&lbPage<lbDoc.numPages){lbPage++;renderLB(lbPage);}
});

/* ─ Shared thumbnail builder ─ */
async function buildThumbGrid(gridEl,statusEl,doc,srcMap,skewResultsArr,onClickFn,skipSkew){
  gridEl.innerHTML=''; const items=[];
  const total=doc.numPages;
  statusEl.textContent=`${EN?`Total ${total} pages`:`총 ${total}페이지`}`;
  for(let p=1;p<=total;p++){
    const src=srcMap[p-1]||'';
    const el=document.createElement('div');
    el.className='thumb-item';
    el.innerHTML=`
      <div class="thumb-canvas-wrap">
        <div class="thumb-skeleton"></div>
        <div class="thumb-skew-badge" id="tSB_${gridEl.id}_${p}"></div>
        <div class="thumb-overlay">🔍</div>
      </div>
      <div class="thumb-skew-angle" id="tSA_${gridEl.id}_${p}"></div>
      <div class="thumb-footer">
        <span class="thumb-num">p${p}</span>
        ${src?`<span class="thumb-src ${src}">${src==='odd'?(EN?'F':'앞'):(EN?'B':'뒤')}</span>`:''}
      </div>`;
    el.addEventListener('click',()=>onClickFn(p));
    gridEl.appendChild(el);items.push(el);
  }
  for(let p=1;p<=total;p++){
    statusEl.textContent=skipSkew?`${EN?`Rendering ${p}/${total}`:`렌더링 ${p}/${total}`}`:`${EN?`Analyzing ${p}/${total}`:`분석 중 ${p}/${total}`}`;
    try{
      const c=await renderPageToCanvas(doc,p,150);
      const wrap=items[p-1].querySelector('.thumb-canvas-wrap');
      const skel=wrap.querySelector('.thumb-skeleton');if(skel)skel.remove();
      wrap.insertBefore(c,wrap.firstChild);
      if(!skipSkew){
        const small=await renderPageToCanvas(doc,p,400);
        const angle=detectSkewAngle(small);
        const level=Math.abs(angle)>=SKEW_ERR?'error':Math.abs(angle)>=SKEW_WARN?'warn':'ok';
        if(skewResultsArr)skewResultsArr[p-1]={angle,level};
        const badge=document.getElementById(`tSB_${gridEl.id}_${p}`);
        const angleEl=document.getElementById(`tSA_${gridEl.id}_${p}`);
        if(level!=='ok'&&badge){badge.textContent=level==='error'?'🔴':'⚠';badge.classList.add('visible');}
        if(level!=='ok'&&angleEl){angleEl.className=`thumb-skew-angle ${level}`;angleEl.textContent=`${angle>=0?'+':''}${angle.toFixed(1)}°`;}
      }
    }catch{}
    await new Promise(r=>setTimeout(r,0));
  }
  statusEl.textContent=`${EN?`Total ${total} pages`:`총 ${total}페이지`}`;
}

function renderSkewPanel(panelEl,badgesEl,listEl,skewResults,srcMap,onClickFn){
  const flagged=skewResults
    .map((r,i)=>({...r,page:i+1,src:srcMap[i]||''}))
    .filter(r=>r&&r.level!=='ok')
    .sort((a,b)=>Math.abs(b.angle)-Math.abs(a.angle));
  if(!flagged.length){panelEl.classList.remove('visible');return;}
  const wC=flagged.filter(r=>r.level==='warn').length;
  const eC=flagged.filter(r=>r.level==='error').length;
  badgesEl.innerHTML=(eC?`<span class="skew-badge error">${EN?`${eC} severe`:`심각 ${eC}페이지`}</span>`:'')+
                     (wC?`<span class="skew-badge warn">${EN?`${wC} warning`:`주의 ${wC}페이지`}</span>`:'');
  const mx=Math.max(...flagged.map(r=>Math.abs(r.angle)));
  listEl.innerHTML=flagged.map(r=>{
    const bp=Math.min(100,(Math.abs(r.angle)/Math.max(mx,SKEW_ERR*2))*100);
    const sgn=r.angle>=0?'+':'';
    return `<div class="skew-row" onclick="${onClickFn}(${r.page})">
      <span class="skew-row-page">p${r.page}</span>
      <div class="skew-row-bar"><div class="skew-row-fill ${r.level}" style="width:${bp}%"></div></div>
      <span class="skew-row-angle ${r.level}">${sgn}${r.angle.toFixed(2)}°</span>
      ${r.src?`<span class="skew-row-src ${r.src}">${r.src==='odd'?(EN?'F':'앞'):(EN?'B':'뒤')}</span>`:''}
    </div>`;
  }).join('');
  panelEl.classList.add('visible');
}

/* ═══════════════════════════════════════════════════
   SCAN CORRECTION (shared post-process for both tabs)
═══════════════════════════════════════════════════ */
function corrGetOptions(){
  const on=document.getElementById('corrToggle').checked;
  const colorMode=document.querySelector('input[name="corrColor"]:checked').value;
  const deskew=document.getElementById('corrDeskew').checked;
  const enhance=document.getElementById('corrEnhance').checked;
  const optimize=document.getElementById('corrOptimize').checked;
  const dpi=parseInt(document.getElementById('corrDpi').value,10);
  const quality=parseInt(document.getElementById('corrQuality').value,10)/100;
  // Pure "color + no deskew + no enhance + no optimize" changes nothing → skip raster.
  const willChange = deskew || optimize || colorMode!=='color' || enhance;
  return {enabled:on&&willChange, colorMode,deskew,enhance,optimize,dpi,quality};
}

/* ═══════════════════════════════════════════════════
   SCAN CORRECTION — driven by Web Worker (off main thread)
═══════════════════════════════════════════════════ */
let corrWorker=null;
function corrWorkerInstance(){
  if(!corrWorker) corrWorker=new Worker('correction-worker.js');
  return corrWorker;
}
let corrCancelled=false;

function processPageViaWorker(bitmap,opts){
  return new Promise((resolve,reject)=>{
    const w=corrWorkerInstance();
    const id=Math.random().toString(36).slice(2)+Date.now().toString(36);
    function onMsg(e){
      const m=e.data; if(!m||m.id!==id)return;
      w.removeEventListener('message',onMsg); w.removeEventListener('error',onErr);
      if(m.type==='done')resolve(m); else reject(new Error(m.message||'worker error'));
    }
    function onErr(e){ w.removeEventListener('message',onMsg); w.removeEventListener('error',onErr); reject(new Error((EN?'Worker error: ':'워커 오류: ')+(e.message||'load failed'))); }
    w.addEventListener('message',onMsg); w.addEventListener('error',onErr);
    w.postMessage({type:'process',id,bitmap,opts},[bitmap]);
  });
}

async function renderPageBitmap(page,dpi){
  const scale=dpi/72;
  const vp=page.getViewport({scale});
  const c=document.createElement('canvas');
  c.width=Math.max(1,Math.round(vp.width)); c.height=Math.max(1,Math.round(vp.height));
  const ctx=c.getContext('2d');
  ctx.fillStyle='#fff'; ctx.fillRect(0,0,c.width,c.height);
  await page.render({canvasContext:ctx,viewport:vp}).promise;
  const bmp=await createImageBitmap(c);
  c.width=c.height=0;
  return bmp;
}

function workerOpts(o){ return {deskew:o.deskew,colorMode:o.colorMode,enhance:o.enhance,quality:o.quality}; }
function pickPreviewPages(n){ return n<=3 ? Array.from({length:n},(_,i)=>i+1) : [...new Set([1,Math.ceil(n/2),n])]; }
const MODE_KO=EN?{bw:'B&W',gray:'Grayscale',color:'Color'}:{bw:'흑백',gray:'회색조',color:'컬러'};

function downloadBytes(bytes,name){
  const blob=new Blob([bytes],{type:'application/pdf'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download=name; a.click();
  setTimeout(()=>URL.revokeObjectURL(url),3000);
}

// Render representative corrected pages (low DPI) into a grid for visual confirmation.
async function buildCorrPreview(pdfBytes,opts,gridEl){
  const src=await pdfjsLib.getDocument({data:pdfBytes.slice()}).promise;
  const pages=pickPreviewPages(src.numPages);
  const wo=workerOpts(opts);
  gridEl.innerHTML=pages.map(p=>`<div class="corr-preview-card" id="cpp_${gridEl.id}_${p}"><div class="corr-preview-skel"></div><div class="cap">${EN?`p${p} · loading`:`p${p} · 준비 중`}</div></div>`).join('');
  for(const pn of pages){
    const page=await src.getPage(pn);
    const bmp=await renderPageBitmap(page,120);
    const r=await processPageViaWorker(bmp,wo);
    const blob=new Blob([r.bytes],{type:r.format==='png'?'image/png':'image/jpeg'});
    const url=URL.createObjectURL(blob);
    const card=document.getElementById(`cpp_${gridEl.id}_${pn}`);
    if(card){
      const ang=Math.abs(r.angle)>=0.05?` · <span class="pp-ang">${r.angle>0?'+':''}${r.angle.toFixed(1)}°${EN?' fix':' 보정'}</span>`:'';
      card.innerHTML=`<img src="${url}" alt="${EN?`p${pn} result`:`p${pn} 보정 결과`}"><div class="cap">p${pn} · <span class="pp-mode">${MODE_KO[r.mode]||r.mode}</span>${ang}</div>`;
    }
    await new Promise(res=>setTimeout(res,0));
  }
}

// Full correction of every page via worker. onProg(frac,msg). Throws Error('cancelled').
async function correctAllViaWorker(pdfBytes,opts,onProg){
  corrCancelled=false;
  const src=await pdfjsLib.getDocument({data:pdfBytes.slice()}).promise;
  const out=await PDFLib.PDFDocument.create();
  const n=src.numPages;
  const dpi=opts.optimize?opts.dpi:200;
  const wo=workerOpts(opts);
  for(let i=1;i<=n;i++){
    if(corrCancelled)throw new Error('cancelled');
    onProg&&onProg((i-1)/n,`${EN?`Cleaning ${i}/${n}`:`보정 중 ${i}/${n}`}`);
    const page=await src.getPage(i);
    const vpPt=page.getViewport({scale:1});
    const bmp=await renderPageBitmap(page,dpi);
    const r=await processPageViaWorker(bmp,wo);
    const embed=r.format==='png'?await out.embedPng(r.bytes):await out.embedJpg(r.bytes);
    const p=out.addPage([vpPt.width,vpPt.height]);
    p.drawImage(embed,{x:0,y:0,width:vpPt.width,height:vpPt.height});
    await new Promise(res=>setTimeout(res,0));
  }
  onProg&&onProg(1,(EN?'Finishing…':'보정 마무리...'));
  return await out.save();
}

/* ── correction panel UI wiring ── */
(function(){
  const t=document.getElementById('corrToggle');
  t.addEventListener('change',()=>document.getElementById('corrBody').classList.toggle('open',t.checked));
  const o=document.getElementById('corrOptimize');
  o.addEventListener('change',()=>document.getElementById('corrOptSub').classList.toggle('open',o.checked));
  document.getElementById('corrQuality').addEventListener('input',e=>document.getElementById('corrQualityVal').textContent=e.target.value);
  document.querySelectorAll('input[name="corrColor"]').forEach(r=>r.addEventListener('change',()=>{
    const m=document.querySelector('input[name="corrColor"]:checked').value;
    document.getElementById('corrColorNote').style.display=(m==='bw'||m==='auto')?'block':'none';
  }));
})();

/* ═══════════════════════════════════════════════════
   TAB A — INTERLEAVE
═══════════════════════════════════════════════════ */
let oddFile=null,evenFile=null,oddPageCount=0,evenPageCount=0;
let ilPdfDoc=null,ilSrcMap=[],ilSkewResults=[];
let ilThumbOpen=false;

const zoneOdd=document.getElementById('zoneOdd');
const zoneEven=document.getElementById('zoneEven');
const btnIL=document.getElementById('btnIL');

function ilSetup(zone,input,type){
  zone.addEventListener('dragover',e=>{e.preventDefault();zone.classList.add('dragover');});
  zone.addEventListener('dragleave',()=>zone.classList.remove('dragover'));
  zone.addEventListener('drop',e=>{e.preventDefault();zone.classList.remove('dragover');const f=e.dataTransfer.files[0];if(f&&f.name.toLowerCase().endsWith('.pdf'))ilHandle(f,type);});
  input.addEventListener('change',()=>{if(input.files[0])ilHandle(input.files[0],type);});
}
ilSetup(zoneOdd,document.getElementById('fileOdd'),'odd');
ilSetup(zoneEven,document.getElementById('fileEven'),'even');

document.getElementById('btnILReset').addEventListener('click',()=>{
  oddFile=null;evenFile=null;oddPageCount=0;evenPageCount=0;
  ilPdfDoc=null;ilSrcMap=[];ilSkewResults=[];ilThumbOpen=false;
  // reset upload zones
  ['Odd','Even'].forEach(t=>{
    const zone=document.getElementById('zone'+t);
    zone.classList.remove('loaded');
    document.getElementById('name'+t).innerHTML='';
    document.getElementById('file'+t).value='';
  });
  document.getElementById('oddThumbs').innerHTML='';
  document.getElementById('evenThumbs').innerHTML='';
  oddPdfJsDoc=null;evenPdfJsDoc=null;
  document.getElementById('ilMergedPreview').classList.remove('visible');
  document.getElementById('ilMergedStrip').innerHTML='';
  ilUpdateChips();
  document.getElementById('ilResult').classList.remove('visible');
  document.getElementById('ilThumbPanel').classList.remove('visible');
  document.getElementById('ilSkewPanel').classList.remove('visible');
  document.getElementById('ilCorrPreview').classList.remove('visible');
  document.getElementById('ilProgress').classList.remove('visible');
  document.getElementById('ilError').classList.remove('visible');
  document.getElementById('btnILThumb').textContent=(EN?'🔍 Preview':'🔍 미리보기');
  btnIL.disabled=true;
});

async function ilHandle(file,type){
  const nameEl=document.getElementById('name'+(type==='odd'?'Odd':'Even'));
  const zone=type==='odd'?zoneOdd:zoneEven;
  try{
    const buf=await file.arrayBuffer();
    const pdf=await PDFLib.PDFDocument.load(buf);
    const count=pdf.getPageCount();
    if(type==='odd'){oddFile=file;oddPageCount=count;}else{evenFile=file;evenPageCount=count;}
    zone.classList.add('loaded');
    nameEl.innerHTML=`<span>${file.name}</span><br><span class="zone-pages">${EN?`${count} pages`:`${count}페이지`}</span>`;
    ilUpdateChips();btnIL.disabled=!(oddFile&&evenFile);
    renderZoneThumbs(file,document.getElementById(type==='odd'?'oddThumbs':'evenThumbs'),type);
  }catch{alert(EN?'Could not read the PDF.':'PDF를 읽을 수 없습니다.');}
}
document.querySelectorAll('input[name="ilOrder"]').forEach(r=>r.addEventListener('change',ilOrderChanged));
function ilGetOrder(){return document.querySelector('input[name="ilOrder"]:checked').value;}
let oddPdfJsDoc=null, evenPdfJsDoc=null, ilMergedToken=0;
async function renderZoneThumbs(file,container,type){
  container.innerHTML='<div class="zt-skel"></div><div class="zt-skel"></div><div class="zt-skel"></div>';
  try{
    const buf=await file.arrayBuffer();
    const doc=await pdfjsLib.getDocument({data:buf.slice()}).promise;
    if(type==='odd')oddPdfJsDoc=doc; else evenPdfJsDoc=doc;
    const pages=pickPreviewPages(doc.numPages);
    container.innerHTML='';
    for(const pn of pages){
      const c=await renderPageToCanvas(doc,pn,220);
      const card=document.createElement('div');card.className='zt-card';
      const lbl=document.createElement('div');lbl.className='zt-num';lbl.textContent='p'+pn;
      card.appendChild(c);card.appendChild(lbl);container.appendChild(card);
    }
    renderMergedPreview();
  }catch{container.innerHTML='';}
}
// Real interleaved preview of the merged result (before clicking merge)
async function renderMergedPreview(){
  const wrap=document.getElementById('ilMergedPreview');
  const strip=document.getElementById('ilMergedStrip');
  const note=document.getElementById('ilMergedNote');
  if(!wrap)return;
  if(!oddPdfJsDoc||!evenPdfJsDoc){wrap.classList.remove('visible');return;}
  const token=++ilMergedToken;
  const order=ilGetOrder();
  const oC=oddPdfJsDoc.numPages, eC=evenPdfJsDoc.numPages;
  const seq=[];
  for(let i=0;i<Math.max(oC,eC);i++){
    if(i<oC)seq.push({doc:oddPdfJsDoc,page:i+1,result:i*2+1,src:'odd'});
    if(i<eC){const bp=order==='reverse'?eC-i:i+1;seq.push({doc:evenPdfJsDoc,page:bp,result:i*2+2,src:'even'});}
  }
  const cap=8;
  const list=seq.slice(0,cap);
  wrap.classList.add('visible');
  note.textContent=`${EN?`· Merged ${seq.length} pages`:`· 합쳐진 결과 ${seq.length}페이지`}${seq.length>cap?` · ${EN?`first ${cap}`:`처음 ${cap}장`}`:''}`;
  strip.innerHTML=list.map(s=>`<div class="mp-card ${s.src}"><div class="mp-canvas" id="mpc_${s.result}"><div class="zt-skel" style="width:100%;height:100%;border:none"></div></div><div class="mp-foot"><span class="mp-num">p${s.result}</span><span class="mp-src ${s.src}">${s.src==='odd'?(EN?'F':'앞'):(EN?'B':'뒤')}</span></div></div>`).join('')+(seq.length>cap?`<div class="mp-more">+${seq.length-cap}</div>`:'');
  for(const s of list){
    if(token!==ilMergedToken)return;
    try{
      const c=await renderPageToCanvas(s.doc,s.page,220);
      const slot=document.getElementById('mpc_'+s.result);
      if(slot){slot.innerHTML='';slot.appendChild(c);}
    }catch{}
  }
}
function ilOrderChanged(){ilUpdateChips();renderMergedPreview();}
function ilUpdateChips(){
  const box=document.getElementById('ilChipBox');
  const wrap=document.getElementById('ilChips');
  const sub=document.getElementById('mvSub');
  const order=ilGetOrder();
  const hasFiles=!!(oddFile||evenFile);
  // real counts when available, else illustrative example
  const oC=hasFiles?oddPageCount:3;
  const eC=hasFiles?evenPageCount:3;
  // back-sheet consumption order (scan-sheet numbers)
  const back=order==='reverse'
    ?Array.from({length:eC},(_,i)=>eC-i)        // 3,2,1  → shows 6,4,2 mapping
    :Array.from({length:eC},(_,i)=>i+1);         // 1,2,3
  const front=Array.from({length:oC},(_,i)=>i+1);
  // dynamic zone titles
  const evenTitle=document.getElementById('evenZoneTitle');
  const oddTitle=document.getElementById('oddZoneTitle');
  if(oddTitle){
    oddTitle.textContent = hasFiles
      ? front.map(n=>n*2-1).slice(0,3).join(' · ')+(oC>3?' · …':'')
      : '1 · 3 · 5 · …';
  }
  if(evenTitle){
    const evenResultPages = back.map((_,i)=>(i+1)*2); // result positions 2,4,6
    if(order==='reverse'){
      evenTitle.innerHTML = hasFiles
        ? '↺ ' + evenResultPages.slice().reverse().slice(0,3).join(' · ')+(eC>3?' · …':'')
        : '↺ … · 6 · 4 · 2';
    }else{
      evenTitle.textContent = hasFiles
        ? evenResultPages.slice(0,3).join(' · ')+(eC>3?' · …':'')
        : '2 · 4 · 6 · …';
    }
  }
  // build result filmstrip (interleaved)
  const result=[];const max=18;
  for(let i=0;i<Math.max(oC,eC);i++){
    if(i<oC)result.push({n:i*2+1,cls:'odd'});
    if(i<eC)result.push({n:i*2+2,cls:'even'});
  }
  const shown=result.slice(0,max);
  const resultCards=shown.map(c=>`<div class="mv-card solid ${c.cls}">${c.n}</div>`).join('')
    +(result.length>max?`<div class="mv-card more">+${result.length-max}</div>`:'');
  // front/back cards show their RESULT page numbers (앞 1·3·5, 뒤 2·4·6 / reverse 6·4·2)
  const frontPages=Array.from({length:oC},(_,i)=>i*2+1);
  const evenPages=Array.from({length:eC},(_,i)=>(i+1)*2);
  const backPages=order==='reverse'?evenPages.slice().reverse():evenPages;
  const fCards=frontPages.slice(0,9).map(n=>`<div class="mv-card solid odd">${n}</div>`).join('')+(oC>9?`<div class="mv-card more">+${oC-9}</div>`:'');
  const bCards=backPages.slice(0,9).map(n=>`<div class="mv-card solid even">${n}</div>`).join('')+(eC>9?`<div class="mv-card more">+${eC-9}</div>`:'');
  wrap.innerHTML=`
    <div class="mv-row">
      <div class="mv-row-head"><span class="mv-dot odd"></span>${EN?`Front scan · ${oC} sheet${oC>1?'s':''}`:`앞면 스캔본 · ${oC}장`}</div>
      <div class="mv-cards">${fCards}</div>
    </div>
    <div class="mv-row">
      <div class="mv-row-head"><span class="mv-dot even"></span>${EN?`Back scan · ${eC} sheet${eC>1?'s':''}`:`뒷면 스캔본 · ${eC}장`}${order==='reverse'?`<span class="mv-flip">${EN?'↺ inserted in reverse':'↺ 역순으로 끼움'}</span>`:''}</div>
      <div class="mv-cards">${bCards}</div>
    </div>
    <div class="mv-join"><div class="mv-join-line"></div><div class="mv-join-txt">${EN?'Interleave':'번갈아 합치기'}</div><div class="mv-join-line"></div></div>
    <div class="mv-result-label">${EN?`Merged result · ${result.length} pages`:`합쳐진 결과 · ${result.length}페이지`}</div>
    <div class="mv-result">${resultCards}</div>`;
  sub.textContent = hasFiles ? (EN?`${oC} front · ${eC} back`:`앞 ${oC}장 · 뒤 ${eC}장`) : (EN?'Example — 3 front · 3 back':'예시 — 앞 3장 · 뒤 3장');
  box.classList.add('visible');
}
ilUpdateChips();

let ilMergedBytes=null;

async function ilFinalize(bytes){
  ilPdfDoc=await pdfjsLib.getDocument({data:bytes.slice()}).promise;
  ilSkewResults=new Array(ilSrcMap.length).fill(null);
  const kb=Math.round(bytes.byteLength/1024);
  const base=oddFile.name.replace(/\.pdf$/i,'');
  document.getElementById('ilResultName').textContent=`${base}_merged.pdf`;
  document.getElementById('ilResultMeta').textContent=`${EN?`Total ${ilSrcMap.length} pages`:`총 ${ilSrcMap.length}페이지`} · ${kb>1024?(kb/1024).toFixed(1)+'MB':kb+'KB'}`;
  document.getElementById('ilResult').classList.add('visible');
  document.getElementById('btnILDown').onclick=()=>downloadBytes(bytes,`${base}_merged.pdf`);
}
const ilProg=()=>{const pf=document.getElementById('ilFill'),pt=document.getElementById('ilText');return (p,t)=>{pf.style.width=p+'%';pt.textContent=t;};};

document.getElementById('btnIL').addEventListener('click',async()=>{
  const errEl=document.getElementById('ilError');errEl.classList.remove('visible');
  ['ilResult','ilThumbPanel','ilSkewPanel','ilCorrPreview'].forEach(id=>document.getElementById(id).classList.remove('visible'));
  ilThumbOpen=false;document.getElementById('btnILThumb').textContent=(EN?'🔍 Preview':'🔍 미리보기');
  btnIL.classList.add('loading');btnIL.disabled=true;
  const pw=document.getElementById('ilProgress');pw.classList.add('visible');
  document.getElementById('ilCancel').style.display='none';
  const sp=ilProg();sp(5,(EN?'Reading PDF files…':'PDF 파일 읽는 중...'));
  try{
    const [ob,eb]=await Promise.all([oddFile.arrayBuffer(),evenFile.arrayBuffer()]);
    sp(20,(EN?'Parsing front PDF…':'앞면 PDF 파싱...'));const od=await PDFLib.PDFDocument.load(ob);
    sp(40,(EN?'Parsing back PDF…':'뒷면 PDF 파싱...'));const ed=await PDFLib.PDFDocument.load(eb);
    sp(55,(EN?'Merging…':'합치는 중...'));const merged=await PDFLib.PDFDocument.create();
    const order=ilGetOrder();
    const oC=od.getPageCount(),eC=ed.getPageCount();
    const ei=order==='reverse'?Array.from({length:eC},(_,i)=>eC-1-i):Array.from({length:eC},(_,i)=>i);
    ilSrcMap=[];
    const pairs=Math.max(oC,eC);
    for(let i=0;i<pairs;i++){
      sp(55+Math.round(i/pairs*30),`${EN?`Merging pages… ${i*2+1}/${pairs*2}`:`페이지 합치는 중... ${i*2+1}/${pairs*2}`}`);
      if(i<oC){const[p]=await merged.copyPages(od,[i]);merged.addPage(p);ilSrcMap.push('odd');}
      if(i<eC){const[p]=await merged.copyPages(ed,[ei[i]]);merged.addPage(p);ilSrcMap.push('even');}
    }
    sp(90,(EN?'Merge complete':'합치기 완료'));
    ilMergedBytes=await merged.save();
    const opts=corrGetOptions();
    if(!opts.enabled){
      sp(100,(EN?'Done!':'완료!'));pw.classList.remove('visible');
      await ilFinalize(ilMergedBytes);
    }else{
      sp(100,(EN?'Building sample-page preview…':'대표 페이지 미리보기 생성 중...'));pw.classList.remove('visible');
      document.getElementById('ilCorrPreview').classList.add('visible');
      await buildCorrPreview(ilMergedBytes,opts,document.getElementById('ilCorrPreviewGrid'));
    }
  }catch(e){errEl.textContent=(EN?'Error: ':'오류: ')+e.message;errEl.classList.add('visible');pw.classList.remove('visible');}
  btnIL.classList.remove('loading');btnIL.disabled=false;
});

document.getElementById('ilCorrApply').addEventListener('click',async()=>{
  if(!ilMergedBytes)return;
  document.getElementById('ilCorrPreview').classList.remove('visible');
  const errEl=document.getElementById('ilError');errEl.classList.remove('visible');
  const pw=document.getElementById('ilProgress');pw.classList.add('visible');
  const cancelBtn=document.getElementById('ilCancel');cancelBtn.style.display='';
  const sp=ilProg();sp(0,(EN?'Starting cleanup…':'보정 시작...'));
  try{
    const bytes=await correctAllViaWorker(ilMergedBytes,corrGetOptions(),(frac,msg)=>sp(Math.round(frac*100),msg));
    sp(100,(EN?'Done!':'완료!'));pw.classList.remove('visible');
    await ilFinalize(bytes);
  }catch(e){
    errEl.textContent=e.message==='cancelled'?(EN?'Cleanup canceled.':'보정을 취소했습니다.'):'오류: '+e.message;
    errEl.classList.add('visible');pw.classList.remove('visible');
  }
  cancelBtn.style.display='none';
});
document.getElementById('ilCorrBack').addEventListener('click',()=>document.getElementById('ilCorrPreview').classList.remove('visible'));
document.getElementById('ilCancel').addEventListener('click',()=>{corrCancelled=true;});

document.getElementById('btnILThumb').addEventListener('click',async()=>{
  if(!ilPdfDoc)return;
  ilThumbOpen=!ilThumbOpen;
  const panel=document.getElementById('ilThumbPanel');
  const btn=document.getElementById('btnILThumb');
  if(ilThumbOpen){
    btn.textContent=(EN?'✕ Close':'✕ 닫기');panel.classList.add('visible');
    const grid=document.getElementById('ilThumbGrid');
    const status=document.getElementById('ilThumbStatus');
    await buildThumbGrid(grid,status,ilPdfDoc,ilSrcMap,ilSkewResults,(p)=>openLightbox(ilPdfDoc,p,ilSrcMap,ilSkewResults),true);
  }else{btn.textContent=(EN?'🔍 Preview':'🔍 미리보기');panel.classList.remove('visible');}
});
window.ilOpenLB=(p)=>openLightbox(ilPdfDoc,p,ilSrcMap,ilSkewResults);

/* ═══════════════════════════════════════════════════
   TAB B — SEQUENTIAL MERGE
═══════════════════════════════════════════════════ */
let seqFiles=[];
let seqIdCounter=0;
let seqPdfDoc=null;
let seqThumbOpen=false;
let seqDragId=null;       // id being reordered internally
let seqExternalDrag=false;// true when OS file is being dragged

const seqDrop=document.getElementById('seqDrop');
const seqFileInput=document.getElementById('seqFileInput');
const seqListEl=document.getElementById('seqList');
const seqActionsWrap=document.getElementById('seqActionsWrap');
const seqListHeader=document.getElementById('seqListHeader');
const seqListCount=document.getElementById('seqListCount');

// Top drop zone (OS files only, not internal reorder)
seqDrop.addEventListener('dragover',e=>{e.preventDefault();seqDrop.classList.add('dragover');});
seqDrop.addEventListener('dragleave',()=>seqDrop.classList.remove('dragover'));
seqDrop.addEventListener('drop',e=>{
  e.preventDefault();seqDrop.classList.remove('dragover');
  if(e.dataTransfer.files.length)seqAddFiles(e.dataTransfer.files,null);
});
seqFileInput.addEventListener('change',()=>{seqAddFiles(seqFileInput.files,null);seqFileInput.value='';});

// Reset
document.getElementById('btnSeqReset').addEventListener('click',()=>{
  seqFiles=[];seqIdCounter=0;seqPdfDoc=null;seqThumbOpen=false;
  seqRenderList();
  ['seqResult','seqThumbPanel','seqProgress','seqError','seqCorrPreview'].forEach(id=>document.getElementById(id).classList.remove('visible'));
  document.getElementById('btnSeqThumb').textContent=(EN?'🔍 Preview':'🔍 미리보기');
});

// Detect OS drag enter/leave for the whole window
document.addEventListener('dragenter',e=>{
  if(e.dataTransfer&&e.dataTransfer.types.includes('Files')&&!seqDragId){
    seqExternalDrag=true;
    if(document.getElementById('tabB').classList.contains('active'))seqShowInsertZones();
  }
});
document.addEventListener('dragleave',e=>{
  if(e.clientX===0&&e.clientY===0){seqExternalDrag=false;seqHideInsertZones();}
});
document.addEventListener('drop',()=>{seqExternalDrag=false;seqHideInsertZones();},true);

function seqShowInsertZones(){document.querySelectorAll('.seq-insert-zone').forEach(z=>z.classList.add('active'));}
function seqHideInsertZones(){document.querySelectorAll('.seq-insert-zone').forEach(z=>z.classList.remove('active'));}

async function seqAddFiles(fileList,insertBeforeId){
  const newEntries=[];
  for(const f of fileList){
    if(!f.name.toLowerCase().endsWith('.pdf'))continue;
    newEntries.push({id:++seqIdCounter,file:f,pageCount:0,pdfJsDoc:null,excludedPages:new Set(),rotations:{}});
  }
  if(!newEntries.length)return;
  if(insertBeforeId!=null){
    const idx=seqFiles.findIndex(f=>f.id===insertBeforeId);
    seqFiles.splice(idx>=0?idx:seqFiles.length,0,...newEntries);
  }else{seqFiles.push(...newEntries);}
  seqRenderList();
  for(const entry of newEntries){
    try{
      const buf=await entry.file.arrayBuffer();
      const pLib=await PDFLib.PDFDocument.load(buf);
      entry.pageCount=pLib.getPageCount();
      entry.pdfJsDoc=await pdfjsLib.getDocument({data:buf.slice()}).promise;
      seqRenderItem(entry);
    }catch{}
  }
}

function seqRenderList(){
  seqListEl.innerHTML='';
  if(seqFiles.length){
    seqListEl.appendChild(seqMakeInsertZone(seqFiles[0].id));
    seqFiles.forEach((e,i)=>{
      seqCreateItem(e);
      const nextId=i+1<seqFiles.length?seqFiles[i+1].id:null;
      seqListEl.appendChild(seqMakeInsertZone(nextId));
    });
  }
  const has=seqFiles.length>0;
  seqActionsWrap.style.display=has?'block':'none';
  seqListHeader.classList.toggle('visible',has);
  if(has)seqListCount.textContent=`${EN?`${seqFiles.length} file${seqFiles.length>1?'s':''}`:`총 ${seqFiles.length}개 파일`}`;
}

function seqMakeInsertZone(insertBeforeId){
  const zone=document.createElement('div');
  zone.className='seq-insert-zone';
  const inner=document.createElement('div');
  inner.className='seq-insert-zone-inner';
  zone.appendChild(inner);
  zone.addEventListener('dragenter',e=>{if(seqExternalDrag){e.preventDefault();zone.classList.add('active');}});
  zone.addEventListener('dragover',e=>{if(seqExternalDrag){e.preventDefault();}});
  zone.addEventListener('dragleave',e=>{if(!zone.contains(e.relatedTarget))zone.classList.remove('active');});
  zone.addEventListener('drop',e=>{
    e.preventDefault();e.stopPropagation();
    zone.classList.remove('active');seqHideInsertZones();
    if(e.dataTransfer.files.length)seqAddFiles(e.dataTransfer.files,insertBeforeId);
  });
  return zone;
}

function seqRenderItem(entry){
  const el=document.getElementById(`seqItem_${entry.id}`);if(!el)return;
  const p=el.querySelector('.seq-file-pages');if(p)p.textContent=(EN?`${entry.pageCount} pages`:`${entry.pageCount}페이지`);
  if(entry.pdfJsDoc){
    renderPageToCanvas(entry.pdfJsDoc,1,72).then(c=>{
      const tw=el.querySelector('.seq-file-thumb');if(tw){tw.innerHTML='';tw.appendChild(c);}
    }).catch(()=>{});
  }
}

function seqCreateItem(entry){
  const el=document.createElement('div');
  el.className='seq-item';el.id=`seqItem_${entry.id}`;el.setAttribute('draggable','true');
  el.innerHTML=`
    <div class="seq-item-header">
      <span class="seq-drag-handle" title="${EN?'Drag to reorder':'드래그로 순서 변경'}">⠿</span>
      <div class="seq-file-thumb"><div class="mini-skel"></div></div>
      <div class="seq-file-info">
        <div class="seq-file-name">${entry.file.name}</div>
        <div class="seq-file-pages">${entry.pageCount?(EN?entry.pageCount+' pages':entry.pageCount+'페이지'):(EN?'Reading…':'읽는 중...')}</div>
      </div>
      <div class="seq-item-actions">
        <button class="seq-icon-btn expand" title="${EN?'View pages':'페이지 보기'}" onclick="seqToggleStrip(${entry.id},this)">▾</button>
        <button class="seq-icon-btn" title="${EN?'Remove':'삭제'}" onclick="seqRemove(${entry.id})">🗑</button>
      </div>
    </div>
    <div class="seq-page-strip" id="seqStrip_${entry.id}">
      <div class="seq-strip-title">${EN?'Page preview · click to exclude · ↻ rotate':'페이지 미리보기 · 클릭하여 제외 · ↻ 회전'}</div>
      <div class="seq-page-grid" id="seqPageGrid_${entry.id}"></div>
    </div>`;
  // Internal reorder drag
  el.addEventListener('dragstart',e=>{
    seqDragId=entry.id;seqExternalDrag=false;
    e.dataTransfer.setData('text/plain',String(entry.id));e.dataTransfer.effectAllowed='move';
    el.classList.add('dragging');seqHideInsertZones();
  });
  el.addEventListener('dragend',()=>{el.classList.remove('dragging');document.querySelectorAll('.seq-item').forEach(i=>i.classList.remove('drag-over'));seqDragId=null;});
  el.addEventListener('dragover',e=>{if(seqDragId!=null&&seqDragId!==entry.id){e.preventDefault();el.classList.add('drag-over');}});
  el.addEventListener('dragleave',()=>el.classList.remove('drag-over'));
  el.addEventListener('drop',e=>{
    e.preventDefault();e.stopPropagation();el.classList.remove('drag-over');
    if(seqDragId==null||seqDragId===entry.id)return;
    const fi=seqFiles.findIndex(f=>f.id===seqDragId),ti=seqFiles.findIndex(f=>f.id===entry.id);
    if(fi<0||ti<0)return;
    const[m]=seqFiles.splice(fi,1);seqFiles.splice(ti,0,m);seqDragId=null;seqRenderList();
  });
  seqListEl.appendChild(el);
}

window.seqToggleStrip=function(id,btn){
  const strip=document.getElementById(`seqStrip_${id}`);
  const isOpen=strip.classList.toggle('open');
  btn.classList.toggle('open',isOpen);btn.textContent=isOpen?'▴':'▾';
  if(isOpen){const e=seqFiles.find(f=>f.id===id);if(e&&e.pdfJsDoc)seqBuildPageGrid(e);}
};

async function seqBuildPageGrid(entry){
  const grid=document.getElementById(`seqPageGrid_${entry.id}`);
  if(!grid||!entry.pdfJsDoc)return;grid.innerHTML='';
  for(let p=1;p<=entry.pageCount;p++){
    const card=document.createElement('div');
    card.className='seq-page-card'+(entry.excludedPages.has(p)?' excluded':'');
    card.id=`seqCard_${entry.id}_${p}`;
    card.innerHTML=`
      <div class="seq-page-canvas-wrap" id="seqCW_${entry.id}_${p}"><div class="thumb-skeleton"></div></div>
      <div class="seq-page-footer">
        <span class="seq-page-num">p${p}</span>
        <button class="seq-rotate-btn" title="${EN?'Rotate 90°':'90° 회전'}" onclick="seqRotate(${entry.id},${p},event)">↻</button>
      </div>`;
    card.addEventListener('click',()=>seqToggleExclude(entry.id,p));
    grid.appendChild(card);
    (async(pn)=>{try{const c=await seqRenderRotated(entry.pdfJsDoc,pn,50,entry.rotations[pn]||0);const cw=document.getElementById(`seqCW_${entry.id}_${pn}`);if(cw){cw.innerHTML='';cw.appendChild(c);}}catch{}})(p);
    await new Promise(r=>setTimeout(r,0));
  }
}

async function seqRenderRotated(doc,pageNum,targetWidth,rotDeg){
  const page=await doc.getPage(pageNum);
  const vp0=page.getViewport({scale:1,rotation:rotDeg});
  const scale=targetWidth/vp0.width;
  const vp=page.getViewport({scale,rotation:rotDeg});
  const c=document.createElement('canvas');c.width=Math.round(vp.width);c.height=Math.round(vp.height);
  await page.render({canvasContext:c.getContext('2d'),viewport:vp}).promise;return c;
}

window.seqToggleExclude=function(id,page){
  const e=seqFiles.find(f=>f.id===id);if(!e)return;
  if(e.excludedPages.has(page))e.excludedPages.delete(page);else e.excludedPages.add(page);
  const card=document.getElementById(`seqCard_${e.id}_${page}`);
  if(card)card.classList.toggle('excluded',e.excludedPages.has(page));
};

window.seqRotate=function(id,page,e){
  e.stopPropagation();
  const entry=seqFiles.find(f=>f.id===id);if(!entry)return;
  entry.rotations[page]=((entry.rotations[page]||0)+90)%360;
  const cw=document.getElementById(`seqCW_${entry.id}_${page}`);
  if(cw&&entry.pdfJsDoc)seqRenderRotated(entry.pdfJsDoc,page,50,entry.rotations[page]).then(c=>{cw.innerHTML='';cw.appendChild(c);}).catch(()=>{});
};

window.seqRemove=function(id){seqFiles=seqFiles.filter(f=>f.id!==id);seqRenderList();};

let seqMergedBytes=null;

async function seqFinalize(bytes){
  seqPdfDoc=await pdfjsLib.getDocument({data:bytes.slice()}).promise;
  const kb=Math.round(bytes.byteLength/1024);
  const base=seqFiles[0]?seqFiles[0].file.name.replace(/\.pdf$/i,''):'merged';
  const name=`${base}_merged.pdf`;
  document.getElementById('seqResultName').textContent=name;
  document.getElementById('seqResultMeta').textContent=`${EN?`Total ${seqPdfDoc.numPages} pages`:`총 ${seqPdfDoc.numPages}페이지`} · ${kb>1024?(kb/1024).toFixed(1)+'MB':kb+'KB'}`;
  document.getElementById('seqResult').classList.add('visible');
  document.getElementById('btnSeqDown').onclick=()=>downloadBytes(bytes,name);
}
const seqProg=()=>{const pf=document.getElementById('seqFill'),pt=document.getElementById('seqText');return (p,t)=>{pf.style.width=p+'%';pt.textContent=t;};};

document.getElementById('btnSeq').addEventListener('click',async()=>{
  if(!seqFiles.length)return;
  const errEl=document.getElementById('seqError');errEl.classList.remove('visible');
  ['seqResult','seqThumbPanel','seqCorrPreview'].forEach(id=>document.getElementById(id).classList.remove('visible'));
  seqThumbOpen=false;document.getElementById('btnSeqThumb').textContent=(EN?'🔍 Preview':'🔍 미리보기');
  const btn=document.getElementById('btnSeq');btn.classList.add('loading');btn.disabled=true;
  const pw=document.getElementById('seqProgress');pw.classList.add('visible');
  document.getElementById('seqCancel').style.display='none';
  const sp=seqProg();sp(5,(EN?'Reading files…':'파일 읽는 중...'));
  try{
    const merged=await PDFLib.PDFDocument.create();
    const total=seqFiles.length;
    for(let fi=0;fi<total;fi++){
      const entry=seqFiles[fi];
      sp(5+Math.round(fi/total*80),`${fi+1}/${total}: ${entry.file.name}`);
      const buf=await entry.file.arrayBuffer();
      const srcDoc=await PDFLib.PDFDocument.load(buf);
      for(let pi=0;pi<entry.pageCount;pi++){
        if(entry.excludedPages.has(pi+1))continue;
        const[page]=await merged.copyPages(srcDoc,[pi]);
        const rot=(entry.rotations[pi+1]||0);
        if(rot)page.setRotation(PDFLib.degrees((page.getRotation().angle+rot)%360));
        merged.addPage(page);
      }
    }
    sp(90,(EN?'Merge complete':'합치기 완료'));
    seqMergedBytes=await merged.save();
    const opts=corrGetOptions();
    if(!opts.enabled){
      sp(100,(EN?'Done!':'완료!'));pw.classList.remove('visible');
      await seqFinalize(seqMergedBytes);
    }else{
      sp(100,(EN?'Building sample-page preview…':'대표 페이지 미리보기 생성 중...'));pw.classList.remove('visible');
      document.getElementById('seqCorrPreview').classList.add('visible');
      await buildCorrPreview(seqMergedBytes,opts,document.getElementById('seqCorrPreviewGrid'));
    }
  }catch(e){errEl.textContent=(EN?'Error: ':'오류: ')+e.message;errEl.classList.add('visible');pw.classList.remove('visible');}
  btn.classList.remove('loading');btn.disabled=false;
});

document.getElementById('seqCorrApply').addEventListener('click',async()=>{
  if(!seqMergedBytes)return;
  document.getElementById('seqCorrPreview').classList.remove('visible');
  const errEl=document.getElementById('seqError');errEl.classList.remove('visible');
  const pw=document.getElementById('seqProgress');pw.classList.add('visible');
  const cancelBtn=document.getElementById('seqCancel');cancelBtn.style.display='';
  const sp=seqProg();sp(0,(EN?'Starting cleanup…':'보정 시작...'));
  try{
    const bytes=await correctAllViaWorker(seqMergedBytes,corrGetOptions(),(frac,msg)=>sp(Math.round(frac*100),msg));
    sp(100,(EN?'Done!':'완료!'));pw.classList.remove('visible');
    await seqFinalize(bytes);
  }catch(e){
    errEl.textContent=e.message==='cancelled'?(EN?'Cleanup canceled.':'보정을 취소했습니다.'):'오류: '+e.message;
    errEl.classList.add('visible');pw.classList.remove('visible');
  }
  cancelBtn.style.display='none';
});
document.getElementById('seqCorrBack').addEventListener('click',()=>document.getElementById('seqCorrPreview').classList.remove('visible'));
document.getElementById('seqCancel').addEventListener('click',()=>{corrCancelled=true;});

document.getElementById('btnSeqThumb').addEventListener('click',async()=>{
  if(!seqPdfDoc)return;
  seqThumbOpen=!seqThumbOpen;
  const panel=document.getElementById('seqThumbPanel');
  const btn=document.getElementById('btnSeqThumb');
  if(seqThumbOpen){
    btn.textContent=(EN?'✕ Close':'✕ 닫기');panel.classList.add('visible');
    const grid=document.getElementById('seqThumbGrid');
    const status=document.getElementById('seqThumbStatus');
    await buildThumbGrid(grid,status,seqPdfDoc,[],[],
      (p)=>openLightbox(seqPdfDoc,p,[],[])
    );
  }else{btn.textContent=(EN?'🔍 Preview':'🔍 미리보기');panel.classList.remove('visible');}
});

/* ═══════════════════════════════════════════════════
   TAB C — COMPRESS (단일 PDF 용량 줄이기)
   Reuses the v4 correction engine; correction is always on.
═══════════════════════════════════════════════════ */
function corrGetOptionsForced(){ const o=corrGetOptions(); return {...o, enabled:true, optimize:true}; }
function fmtSize(b){ const kb=b/1024; return kb>1024?(kb/1024).toFixed(1)+'MB':Math.round(kb)+'KB'; }

let cmpFile=null, cmpOrigBytes=null, cmpPdfDoc=null, cmpThumbOpen=false;

const cmpDrop=document.getElementById('cmpDrop');
const cmpFileInput=document.getElementById('cmpFileInput');
const btnCmp=document.getElementById('btnCmp');

cmpDrop.addEventListener('dragover',e=>{e.preventDefault();cmpDrop.classList.add('dragover');});
cmpDrop.addEventListener('dragleave',()=>cmpDrop.classList.remove('dragover'));
cmpDrop.addEventListener('drop',e=>{e.preventDefault();cmpDrop.classList.remove('dragover');const f=e.dataTransfer.files[0];if(f&&f.name.toLowerCase().endsWith('.pdf'))cmpHandle(f);});
cmpFileInput.addEventListener('change',()=>{if(cmpFileInput.files[0])cmpHandle(cmpFileInput.files[0]);});

async function cmpHandle(file){
  try{
    const buf=await file.arrayBuffer();
    const u8=new Uint8Array(buf);
    const pdf=await PDFLib.PDFDocument.load(u8.slice());
    cmpFile=file; cmpOrigBytes=u8;
    cmpDrop.classList.add('loaded');
    document.getElementById('cmpName').innerHTML=`<span>${file.name}</span><br><span class="zone-pages">${EN?`${pdf.getPageCount()} pages`:`${pdf.getPageCount()}페이지`} · ${fmtSize(file.size)}</span>`;
    btnCmp.disabled=false;
  }catch{alert(EN?'Could not read the PDF.':'PDF를 읽을 수 없습니다.');}
}

document.getElementById('btnCmpReset').addEventListener('click',()=>{
  cmpFile=null;cmpOrigBytes=null;cmpPdfDoc=null;cmpThumbOpen=false;
  cmpDrop.classList.remove('loaded');document.getElementById('cmpName').innerHTML='';cmpFileInput.value='';
  ['cmpResult','cmpThumbPanel','cmpProgress','cmpError','cmpCorrPreview'].forEach(id=>document.getElementById(id).classList.remove('visible'));
  document.getElementById('btnCmpThumb').textContent=(EN?'🔍 Preview':'🔍 미리보기');
  btnCmp.disabled=true;
});

const cmpProg=()=>{const pf=document.getElementById('cmpFill'),pt=document.getElementById('cmpText');return (p,t)=>{pf.style.width=p+'%';pt.textContent=t;};};

async function cmpFinalize(bytes){
  cmpPdfDoc=await pdfjsLib.getDocument({data:bytes.slice()}).promise;
  const base=cmpFile.name.replace(/\.pdf$/i,'');
  const orig=cmpFile.size, now=bytes.byteLength;
  const pct=orig>0?Math.max(0,Math.round((1-now/orig)*100)):0;
  document.getElementById('cmpResultName').textContent=`${base}_compressed.pdf`;
  document.getElementById('cmpResultMeta').innerHTML=`${EN?`Total ${cmpPdfDoc.numPages} pages`:`총 ${cmpPdfDoc.numPages}페이지`} · ${fmtSize(orig)} → ${fmtSize(now)} <span style="color:var(--ok)">(${pct}%${EN?' smaller':' 감소'})</span>`;
  document.getElementById('cmpResult').classList.add('visible');
  document.getElementById('btnCmpDown').onclick=()=>downloadBytes(bytes,`${base}_compressed.pdf`);
}

document.getElementById('btnCmp').addEventListener('click',async()=>{
  if(!cmpOrigBytes)return;
  const errEl=document.getElementById('cmpError');errEl.classList.remove('visible');
  ['cmpResult','cmpThumbPanel','cmpCorrPreview'].forEach(id=>document.getElementById(id).classList.remove('visible'));
  cmpThumbOpen=false;document.getElementById('btnCmpThumb').textContent=(EN?'🔍 Preview':'🔍 미리보기');
  btnCmp.classList.add('loading');btnCmp.disabled=true;
  const pw=document.getElementById('cmpProgress');pw.classList.add('visible');
  document.getElementById('cmpCancel').style.display='none';
  const sp=cmpProg();sp(100,(EN?'Building sample-page preview…':'대표 페이지 미리보기 생성 중...'));
  try{
    document.getElementById('cmpCorrPreview').classList.add('visible');
    await buildCorrPreview(cmpOrigBytes,corrGetOptionsForced(),document.getElementById('cmpCorrPreviewGrid'));
    pw.classList.remove('visible');
  }catch(e){errEl.textContent=(EN?'Error: ':'오류: ')+e.message;errEl.classList.add('visible');pw.classList.remove('visible');}
  btnCmp.classList.remove('loading');btnCmp.disabled=false;
});

document.getElementById('cmpCorrApply').addEventListener('click',async()=>{
  if(!cmpOrigBytes)return;
  document.getElementById('cmpCorrPreview').classList.remove('visible');
  const errEl=document.getElementById('cmpError');errEl.classList.remove('visible');
  const pw=document.getElementById('cmpProgress');pw.classList.add('visible');
  const cancelBtn=document.getElementById('cmpCancel');cancelBtn.style.display='';
  const sp=cmpProg();sp(0,(EN?'Starting cleanup…':'보정 시작...'));
  try{
    const bytes=await correctAllViaWorker(cmpOrigBytes,corrGetOptionsForced(),(frac,msg)=>sp(Math.round(frac*100),msg));
    sp(100,(EN?'Done!':'완료!'));pw.classList.remove('visible');
    await cmpFinalize(bytes);
  }catch(e){
    errEl.textContent=e.message==='cancelled'?(EN?'Canceled.':'취소했습니다.'):'오류: '+e.message;
    errEl.classList.add('visible');pw.classList.remove('visible');
  }
  cancelBtn.style.display='none';
});
document.getElementById('cmpCorrBack').addEventListener('click',()=>document.getElementById('cmpCorrPreview').classList.remove('visible'));
document.getElementById('cmpCancel').addEventListener('click',()=>{corrCancelled=true;});

document.getElementById('btnCmpThumb').addEventListener('click',async()=>{
  if(!cmpPdfDoc)return;
  cmpThumbOpen=!cmpThumbOpen;
  const panel=document.getElementById('cmpThumbPanel');
  const btn=document.getElementById('btnCmpThumb');
  if(cmpThumbOpen){
    btn.textContent=(EN?'✕ Close':'✕ 닫기');panel.classList.add('visible');
    await buildThumbGrid(document.getElementById('cmpThumbGrid'),document.getElementById('cmpThumbStatus'),cmpPdfDoc,[],[],(p)=>openLightbox(cmpPdfDoc,p,[],[]));
  }else{btn.textContent=(EN?'🔍 Preview':'🔍 미리보기');panel.classList.remove('visible');}
});
