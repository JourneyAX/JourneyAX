import sharp from 'sharp';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, 'output');
await mkdir(out, { recursive: true });
const W = 1280, H = 720, FPS = 20;
const C = { black:'#070707', dark:'#101010', raised:'#1B1B1B', yellow:'#FFD600', white:'#FFFDF6', grey:'#A8A8A2', line:'#494943', paper:'#F4F2EA', ink:'#11110F' };
const frames = [
  { name:'01-the-goal', seconds:12 },
  { name:'02-the-silos', seconds:15 },
  { name:'03-connect-the-systems', seconds:18 },
  { name:'04-build-agents', seconds:13 },
  { name:'05-business-pack', seconds:15 },
  { name:'06-adaptive-journey', seconds:17 },
  { name:'07-building-supplies', seconds:15 },
  { name:'08-manufacturing', seconds:15 },
  { name:'09-apparel', seconds:15 },
  { name:'10-agent-in-action', seconds:17 },
  { name:'11-studio-insights', seconds:13 },
  { name:'12-ownership', seconds:12 }
];
const total = frames.reduce((sum,s)=>sum+s.seconds,0);
const clamp=(n,a=0,b=1)=>Math.max(a,Math.min(b,n));
const ease=(n)=>{n=clamp(n);return n*n*(3-2*n);};
const progress=(t,start,duration=.75)=>ease((t-start)/duration);
const esc=(s)=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const R=(x,y,w,h,fill=C.raised,r=0,stroke='none',sw=1)=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
const L=(x1,y1,x2,y2,color=C.line,sw=2)=>`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${sw}" stroke-linecap="round"/>`;
const T=(x,y,s,size=32,color=C.white,weight=600,anchor='start')=>`<text x="${x}" y="${y}" fill="${color}" font-family="Arial, Helvetica, sans-serif" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}">${esc(s)}</text>`;
const D=(x,y,r,fill=C.yellow)=>`<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}"/>`;
const bezier=(a,b,c,d,u)=>({x:(1-u)**3*a.x+3*(1-u)**2*u*b.x+3*(1-u)*u*u*c.x+u**3*d.x,y:(1-u)**3*a.y+3*(1-u)**2*u*b.y+3*(1-u)*u*u*c.y+u**3*d.y});
const curve=(a,b,c,d,color='#716F5B',sw=2)=>`<path d="M ${a.x} ${a.y} C ${b.x} ${b.y}, ${c.x} ${c.y}, ${d.x} ${d.y}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round"/>`;
const show=(piece,p,dx=0,dy=28)=>`<g opacity="${p.toFixed(3)}" transform="translate(${(dx*(1-p)).toFixed(1)} ${(dy*(1-p)).toFixed(1)})">${piece}</g>`;
const eyebrow=(n,s)=>R(64,52,28,3,C.yellow)+T(104,63,`${String(n).padStart(2,'0')}  /  ${s.toUpperCase()}`,16,C.grey,700);
const foot=(s='CONCEPT FILM · ILLUSTRATIVE EXPERIENCE')=>L(64,672,1216,672,C.line,1)+T(64,696,s,13,C.grey,500);
const panel=(x,y,w,h,label,sub='',active=false)=>R(x,y,w,h,active?C.yellow:C.raised,16,active?'none':C.line,1.5)+T(x+24,y+48,label,26,active?C.ink:C.white,700)+(sub?T(x+24,y+84,sub,17,active?C.ink:C.grey,400):'');
const labelPill=(x,y,text,active=false,w=170)=>R(x,y,w,43,active?C.yellow:C.raised,21,active?'none':C.line,1)+T(x+w/2,y+28,text,16,active?C.ink:C.white,700,'middle');
const grid=()=>Array.from({length:13},(_,i)=>L(i*120,0,i*120,H,'#171715',1)).join('')+Array.from({length:8},(_,i)=>L(0,i*110,W,i*110,'#171715',1)).join('');
const intro=(title,sub,n,section)=>eyebrow(n,section)+T(64,142,title,57,C.white,700)+(sub?T(66,187,sub,23,C.grey,400):'');
const photoShade=()=>`<defs><linearGradient id="shade"><stop stop-color="#070707" stop-opacity=".96"/><stop offset=".72" stop-color="#070707" stop-opacity=".78"/><stop offset="1" stop-color="#070707" stop-opacity="0"/></linearGradient></defs>${R(0,0,750,H,'url(#shade)')}`;
const photoTitle=(n,section,headline,secondary)=>photoShade()+eyebrow(n,section)+T(62,205,headline,47,C.white,700)+T(64,252,secondary,24,C.yellow,500);

const photos={};
for(const key of ['laundry-hero','manufacturing','apparel']) photos[key]=await sharp(join(root,'assets',`${key}.png`)).resize(W,H,{fit:'cover'}).png().toBuffer();
photos.arch=await sharp(join(root,'assets/connected-context-plate.png')).resize(W,H,{fit:'cover'}).blur(5).modulate({brightness:.54}).png().toBuffer();
const montage=await sharp({create:{width:W,height:H,channels:3,background:C.black}}).composite([
  {input:await sharp(photos['laundry-hero']).extract({left:450,top:0,width:426,height:720}).toBuffer(),left:0,top:0},
  {input:await sharp(photos.manufacturing).extract({left:450,top:0,width:426,height:720}).toBuffer(),left:426,top:0},
  {input:await sharp(photos.apparel).extract({left:450,top:0,width:428,height:720}).toBuffer(),left:852,top:0}
]).png().toBuffer();
const logo=await sharp(join(root,'assets/logo-yellow.png')).resize({width:350}).png().toBuffer();
const logoLarge=await sharp(join(root,'assets/logo-yellow.png')).resize({width:640}).png().toBuffer();
const logoMark=await sharp(join(root,'assets/logo-mark-yellow.png')).resize({width:86}).png().toBuffer();

function scene0(t){
  const q=Math.floor(t/4)%3, names=['BUILDING','MANUFACTURING','RETAIL'];
  const alpha=progress(t,0,.9);
  const overlay=`${R(0,0,W,H,'#070707',0)}<g opacity=".52"><image href="data:image/png;base64,${montage.toString('base64')}" width="1280" height="720"/></g>`+
    R(0,0,820,H,'url(#shade)')+`<defs><linearGradient id="shade"><stop stop-color="#070707" stop-opacity=".98"/><stop offset="1" stop-color="#070707" stop-opacity="0"/></linearGradient></defs>`+
    show(eyebrow(1,'the starting point'),alpha)+show(T(64,270,'People do not arrive',62,C.white,700)+T(64,345,'with a product code.',62,C.white,700),progress(t,.6,.9))+
    show(T(68,420,'They arrive with a goal.',34,C.yellow,600),progress(t,1.5,.7))+
    show(labelPill(66,530,names[q],true,225),progress(t,2,.5));
  return {overlay,logo:'small'};
}

function scene1(t){
  let s=R(0,0,W,H,C.black)+grid()+intro('The answer is scattered.','Six systems. No shared customer moment.',2,'today’s problem');
  const nodes=[['ERP',80,300],['CRM',440,300],['PIM',800,300],['COMMERCE',80,480],['SEARCH',440,480],['SERVICE',800,480]];
  nodes.forEach(([name,x,y],i)=>{const p=progress(t,1+i*.45,.7);s+=show(panel(x,y,300,115,name,'A separate view'),p,0,65);});
  s+=show(T(66,624,'The shopper repeats the need. Teams bridge the gaps.',25,C.yellow,500),progress(t,6,.8));
  if(t>8){const blink=.4+.6*Math.abs(Math.sin((t-8)*2.3));s+=`<g opacity="${blink.toFixed(2)}">${L(378,359,438,359,C.grey,3)}${L(738,359,798,359,C.grey,3)}</g>`;}
  return {overlay:s+foot()};
}

function scene2(t){
  const left=['ERP','CRM','PIM','COMMERCE','SEARCH','KNOWLEDGE'];
  const right=['GUIDED ANSWERS','REAL PRODUCT OPTIONS','CARTS & QUOTES','HUMAN HANDOFF','JOURNEY INSIGHTS'];
  const ly=[202,269,336,403,470,537],ry=[219,299,379,459,539];
  let s=`${R(0,0,W,H,'#070707')}
    <g opacity=".62"><image href="data:image/png;base64,${photos.arch.toString('base64')}" width="1280" height="720"/></g>
    <rect x="35" y="156" width="1210" height="495" rx="30" fill="#0D0D0C" fill-opacity=".78" stroke="#DCD8B9" stroke-opacity=".33" stroke-width="1.5"/>`+
    eyebrow(3,'connected context')+T(64,133,'Your systems. One guided journey.',47,C.white,700);
  const inputPaths=ly.map((y)=>[{x:334,y:y+25},{x:450,y:y+25},{x:472,y:405},{x:565,y:405}]);
  const outputPaths=ry.map((y)=>[{x:715,y:405},{x:808,y:405},{x:826,y:y+25},{x:943,y:y+25}]);
  inputPaths.forEach((p,i)=>{s+=show(curve(...p,'#807E69',2),progress(t,.5+i*.18,.5),0,0);});
  outputPaths.forEach((p,i)=>{s+=show(curve(...p,'#807E69',2),progress(t,3+i*.2,.5),0,0);});
  left.forEach((name,i)=>{const y=ly[i];s+=show(R(102,y,232,50,'#26302E',12,'#B9C1A2',1)+R(102,y,5,50,C.yellow,3)+T(128,y+32,name,21,C.white,700),progress(t,.3+i*.27,.5),-25,0);});
  right.forEach((name,i)=>{const y=ry[i];s+=show(R(943,y,235,50,C.yellow,12)+T(1061,y+32,name,17,C.ink,700,'middle'),progress(t,3+i*.28,.55),25,0);});
  s+=show(`<rect x="565" y="319" width="150" height="175" rx="25" fill="#10100E" stroke="#FFD600" stroke-width="2.5"/>`+
    T(640,469,'JAX',28,C.yellow,800,'middle'),progress(t,2.5,.6),0,0);
  // Several continuously circulating signals make the direction of the exchange legible.
  inputPaths.forEach((p,i)=>{if(t<1.6+i*.2)return;const u=((t-1.6-i*.2)%2.4+2.4)%2.4/2.4;const q=bezier(...p,u);s+=`<g opacity=".25">${D(q.x,q.y,13,C.yellow)}</g>`+D(q.x,q.y,5,C.yellow);});
  outputPaths.forEach((p,i)=>{if(t<4+i*.18)return;const u=((t-4-i*.18)%2.4+2.4)%2.4/2.4;const q=bezier(...p,u);s+=`<g opacity=".25">${D(q.x,q.y,13,C.yellow)}</g>`+D(q.x,q.y,5,C.yellow);});
  s+=T(640,539,'CONTEXT → DECISION → ACTION',15,C.white,700,'middle');
  return {overlay:s+foot('ILLUSTRATIVE FLOW · PRICES, STOCK AND ORDERS STAY WITH THEIR SOURCE SYSTEMS'),mark:'center'};
}

function scene3(t){
  let s=R(0,0,W,H,C.black)+intro('Build the agents your business needs.','Give each role the right knowledge and approved actions.',4,'agent studio');
  const a=[['DISCOVERY ADVISOR','Understand the goal'],['PRODUCT SPECIALIST','Compare real options'],['QUOTE ASSISTANT','Prepare the next step']];
  a.forEach(([name,sub],i)=>{
    const x=65+i*405, p=progress(t,1+i*1.15,.65);
    const active=i===Math.floor(Math.max(0,t-2)/2.7)%3;
    s+=show(R(x,284,365,235,active?C.yellow:C.raised,22,active?'none':C.line,2)+
      D(x+38,326,13,active?C.ink:C.yellow)+T(x+63,338,name,21,active?C.ink:C.white,700)+
      T(x+28,405,sub,26,active?C.ink:C.white,600)+T(x+28,454,'Knowledge · tools · limits',19,active?C.ink:C.grey,400),p,0,55);
  });
  const q=progress(t,7,.9);
  s+=show(L(255,561,1040,561,C.yellow,4)+D(255,561,9)+D(649,561,9)+D(1040,561,9)+
    T(650,616,'One platform. Different jobs. Merchant control.',28,C.white,600,'middle'),q);
  return {overlay:s+foot('ROLE AND TOOL EXAMPLES · ILLUSTRATIVE')};
}

function scene4(t){
  let s=R(0,0,W,H,C.black)+grid()+intro('The Business Pack is the playbook.','What the merchant wants the experience to know, do and show.',5,'merchant control');
  const tiles=[['BRAND VOICE',65,273],['KNOWLEDGE',65,410],['AGENTS',450,273],['JOURNEYS',450,410],['RULES',835,273],['CARDS & THEMES',835,410]];
  tiles.forEach(([a,x,y],i)=>{const p=progress(t,.7+i*.52,.7);s+=show(panel(x,y,348,112,a,'',i===Math.floor(Math.max(0,t-4)/1.8)%6),p,0,36);});
  const q=progress(t,5.6,1.1);s+=show(L(236,586,1046,586,C.yellow,4)+D(236,586,10)+D(641,586,10)+D(1046,586,10)+
    T(641,633,'Publish one coherent merchant experience.',28,C.white,600,'middle'),q);
  if(t>6.5)s+=D(236+810*(((t-6.5)%3)/3),586,11,C.white);
  return {overlay:s+foot('THE PACK CONFIGURES THE JOURNEY; LIVE PRICES AND STOCK REMAIN WITH CONNECTED SYSTEMS')};
}

function scene5(t){
  let s=R(0,0,W,H,C.black)+intro('A journey adapts to the goal.','It is not a fixed question list or a compulsory card sequence.',6,'journey logic');
  const points=[['GOAL',110,405],['UNDERSTAND',352,405],['DECIDE',594,405],['RECOMMEND',866,405],['COMPLETE',1110,405]];
  points.forEach(([a,x,y],i)=>{
    const p=progress(t,1+i*1.35,.8);
    const active=i===Math.floor(Math.max(0,t-1)/2.5)%5;
    s+=show(D(x,y,29,active?C.yellow:C.raised)+T(x,y+7,String(i+1),22,active?C.ink:C.white,700,'middle')+
      T(x,y+86,a,18,C.white,700,'middle'),p,0,25);
    if(i>0){const q=progress(t,1.7+(i-1)*1.35,.65);s+=L(points[i-1][1]+30,y,x-30,y,'#484841',4)+L(points[i-1][1]+30,y,points[i-1][1]+30+(x-points[i-1][1]-60)*q,y,C.yellow,4);}
  });
  const b=progress(t,8,.7);
  s+=show(R(430,534,420,73,C.raised,13,C.line,1)+T(640,579,'Enough context? Act. Missing detail? Ask.',22,C.yellow,600,'middle'),b);
  if(t>8)s+=D(110+1000*(((t-8)%4)/4),405,8,C.white);
  return {overlay:s+foot('CARDS AND TOOLS APPEAR WHEN RELEVANT TO THE CUSTOMER’S NEXT STEP')};
}

function photoScene(t,photo,n,section,headline,sub,steps){
  let s=photoTitle(n,section,headline,sub);
  steps.forEach(([label,detail],i)=>{
    const p=progress(t,2+i*3.3,.7),y=326+i*95;
    s+=show(R(66,y,580,77,i===Math.min(2,Math.floor(Math.max(0,t-2)/3.3))?C.yellow:'#232320',12,'#57574E',1)+
      D(96,y+38,10,i===Math.min(2,Math.floor(Math.max(0,t-2)/3.3))?C.ink:C.yellow)+
      T(123,y+33,label,23,i===Math.min(2,Math.floor(Math.max(0,t-2)/3.3))?C.ink:C.white,700)+
      T(123,y+60,detail,17,i===Math.min(2,Math.floor(Math.max(0,t-2)/3.3))?C.ink:C.grey,400),p,28,0);
  });
  return {overlay:s+foot('ILLUSTRATIVE CUSTOMER JOURNEY · MERCHANT-CONTROLLED CONTENT'),photo};
}
function scene6(t){return photoScene(t,'laundry-hero',7,'building supplies','“Renovating the laundry.”','Project-led advice, not a keyword dump.',[
  ['UNDERSTAND','Existing space, appliances and storage goal'],
  ['GUIDE','Ask only for the next missing detail'],
  ['HELP DECIDE','Relevant materials, reasons, plan or quote']
]);}
function scene7(t){return photoScene(t,'manufacturing',8,'manufacturing','“Configure a component.”','Requirements become a controlled quote path.',[
  ['CAPTURE REQUIREMENTS','Fit, quantity, standards and delivery need'],
  ['CHECK THE SOURCE','Approved product data and availability'],
  ['PREPARE THE OUTCOME','Option, specification, quote or human review']
]);}
function scene8(t){return photoScene(t,'apparel',9,'retail & apparel','“Help me find the fit.”','Advice can change with customer context.',[
  ['UNDERSTAND','Occasion, preference and fit needs'],
  ['CURATE','Appropriate items and availability'],
  ['COMPLETE','Explain the look, then build the basket']
]);}

function scene9(t){
  let s=R(0,0,W,H,C.black)+grid()+intro('Agents work through the journey.','They use approved capabilities and return a useful next step.',10,'how it works');
  const nodes=[['CUSTOMER GOAL',67,325,234],['JOURNEY',354,325,234],['AGENT',641,325,234],['RESULT',928,325,234]];
  nodes.forEach(([a,x,y,w],i)=>{const p=progress(t,.6+i*1.5,.7);s+=show(panel(x,y,w,111,a,'',i===2),p,0,40);});
  for(let i=0;i<3;i++){
    const x=301+i*287,p=progress(t,2+i*1.5,1.2);
    s+=L(x,380,x+52,380,'#494941',4)+L(x,380,x+52*p,380,C.yellow,4);
    if(p>0)s+=D(x+52*p,380,6,C.yellow);
  }
  const tools=[['FIND PRODUCTS',87],['CHECK LIVE DATA',373],['READ GUIDANCE',659],['PREPARE ACTION',945]];
  tools.forEach(([a,x],i)=>{const p=progress(t,7+i*.6,.65);s+=show(labelPill(x,508,a,i===Math.floor(Math.max(0,t-7)/1.7)%4,248),p,0,22);});
  s+=show(T(640,615,'Answer + reason + the right visual or action.',29,C.white,600,'middle'),progress(t,10,.8));
  return {overlay:s+foot('ACTUAL AVAILABLE ACTIONS DEPEND ON THE MERCHANT’S CONNECTIONS AND PERMISSIONS')};
}

function scene10(t){
  let s=R(0,0,W,H,C.black)+intro('The merchant stays in control.','Connect, configure, review and improve from JourneyAX Studio.',11,'operating the business');
  s+=R(65,238,1150,384,C.dark,20,C.line,2)+R(65,238,244,384,'#171717',20)+
    ['Connections','Agents','Journeys','Business Packs','Insights'].map((a,i)=>{
      const y=291+i*62,p=progress(t,.8+i*.55,.6);
      return show(R(83,y-28,207,43,i===Math.min(4,Math.floor(Math.max(0,t-.8)/.55))?C.yellow:'none',9)+
        T(104,y,a,20,i===Math.min(4,Math.floor(Math.max(0,t-.8)/.55))?C.ink:C.grey,600),p,-25,0);
    }).join('');
  s+=T(355,304,'Journey insights',35,C.white,700)+T(355,349,'What customers need and where the path can improve',19,C.grey,400);
  const pts=[[393,534],[550,502],[706,467],[863,435],[1020,401]];
  pts.forEach(([x,y],i)=>{
    const p=progress(t,5+i*.85,.6);
    if(i>0){const [px,py]=pts[i-1];s+=L(px,py,x,y,C.line,3)+L(px,py,px+(x-px)*p,py+(y-py)*p,C.yellow,4);}
    s+=show(D(x,y,9,C.yellow)+T(x,y-28,['Goal','Clarify','Options','Quote','Next step'][i],16,C.white,600,'middle'),p);
  });
  s+=show(R(355,564,798,36,'#232320',7)+T(377,589,'No invented metrics. Review real journey events when connected.',16,C.grey,400),progress(t,9,.6));
  return {overlay:s+foot('ILLUSTRATIVE STUDIO VIEW · NO CUSTOMER DATA OR METRICS SHOWN')};
}

function scene11(t){
  let s=R(0,0,W,H,C.black)+`<defs><radialGradient id="glow"><stop stop-color="#FFD600" stop-opacity=".18"/><stop offset="1" stop-color="#FFD600" stop-opacity="0"/></radialGradient></defs>`+
    `<circle cx="640" cy="365" r="520" fill="url(#glow)"/>`;
  s+=show(T(640,390,'Your customer.',53,C.white,700,'middle')+T(640,458,'Your brand. Your journey.',53,C.yellow,700,'middle'),progress(t,1,.8));
  s+=show(T(640,556,'Build your own AI salesperson.',27,C.white,500,'middle')+T(640,621,'journeyax.com',25,C.yellow,700,'middle'),progress(t,4,.8));
  return {overlay:s+foot('JOURNEYAX · CONCEPT FILM'),logo:'large'};
}
const builders=[scene0,scene1,scene2,scene3,scene4,scene5,scene6,scene7,scene8,scene9,scene10,scene11];

function locate(t){let at=0;for(let i=0;i<frames.length;i++){if(t<at+frames[i].seconds)return {i,local:t-at};at+=frames[i].seconds;}return {i:frames.length-1,local:frames.at(-1).seconds-.01};}
function svg(markup){return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${markup}</svg>`);}
async function render(t){
  const {i,local}=locate(t),spec=builders[i](local);
  const layers=[];
  if(spec.photo){
    const amount=clamp(local/frames[i].seconds), cropW=Math.round(W-54*amount), cropH=Math.round(H-30*amount);
    const movingPhoto=await sharp(photos[spec.photo]).extract({left:Math.round((W-cropW)*amount),top:Math.round((H-cropH)*.5),width:cropW,height:cropH}).resize(W,H).png().toBuffer();
    layers.push({input:movingPhoto,left:0,top:0});
  }
  layers.push({input:await sharp(svg(spec.overlay)).png().toBuffer(),left:0,top:0});
  if(spec.logo==='small') layers.push({input:logo,left:64,top:80});
  if(spec.logo==='large') layers.push({input:logoLarge,left:320,top:145});
  if(spec.mark==='center' && local>2.5) layers.push({input:logoMark,left:597,top:341});
  return sharp({create:{width:W,height:H,channels:4,background:C.black}}).composite(layers).png().toBuffer();
}

await writeFile(join(out,'timing.json'),JSON.stringify({durationSeconds:total,fps:FPS,scenes:frames},null,2)+'\n');
for(let i=0,at=0;i<frames.length;at+=frames[i].seconds,i++){
  const p=join(out,`${String(i+1).padStart(2,'0')}-${frames[i].name}.png`);
  await writeFile(p,await render(at+Math.min(frames[i].seconds-1,Math.max(2,frames[i].seconds*.55))));
}
const thumbs=await Promise.all(frames.map(async(s,i)=>({input:await sharp(join(out,`${String(i+1).padStart(2,'0')}-${s.name}.png`)).resize(320,180).png().toBuffer(),left:(i%4)*320,top:Math.floor(i/4)*180})));
await sharp({create:{width:1280,height:540,channels:3,background:C.black}}).composite(thumbs).jpeg({quality:88}).toFile(join(out,'storyboard.jpg'));

if(process.argv.includes('--video')){
  const child=spawn('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','image2pipe','-vcodec','png','-framerate',String(FPS),'-i','-','-an','-c:v','libx264','-preset','veryfast','-crf','19','-pix_fmt','yuv420p','-vf','scale=1920:1080:flags=lanczos','-r',String(FPS),'-movflags','+faststart',join(out,'journeyax-launch-v2-silent.mp4')],{stdio:['pipe','ignore','pipe']});
  let error=''; child.stderr.on('data',chunk=>error+=chunk.toString());
  for(let f=0;f<Math.round(total*FPS);f++){
    const buf=await render(f/FPS);
    if(!child.stdin.write(buf))await once(child.stdin,'drain');
    if(f%200===0)process.stdout.write(`rendered ${f}/${Math.round(total*FPS)} frames\n`);
  }
  child.stdin.end();
  const [code]=await once(child,'close');
  if(code!==0)throw new Error(`ffmpeg failed (${code}): ${error}`);
}
