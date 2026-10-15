import sharp from 'sharp';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, 'output');
const assets = join(root, 'assets');
await mkdir(out, { recursive: true });

const W = 1920, H = 1080;
const embedded = Object.fromEntries(await Promise.all(['logo-yellow.png','laundry-hero.png','merchant-consult.png'].map(async (name) => [
  `../assets/${name}`,
  `data:image/png;base64,${(await readFile(join(assets,name))).toString('base64')}`
])));
const C = { yellow: '#FFD600', black: '#070707', dark: '#0E0E0E', raised: '#171717', white: '#FFFDF6', paper: '#F4F2EA', muted: '#A9A9A2', line: '#3A3A37', ink: '#11110F' };
const esc = (s) => String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const svg = (body, bg=C.black) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="${bg}"/>${body}</svg>`;
const rect=(x,y,w,h,fill,r=0,stroke='none',sw=1)=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
const line=(x1,y1,x2,y2,color=C.line,sw=2,dash='')=>`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${sw}" ${dash?`stroke-dasharray="${dash}"`:''}/>`;
const circle=(x,y,r,fill,stroke='none',sw=1)=>`<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
const txt=(x,y,s,size=44,color=C.white,weight=600,anchor='start',extra='')=>`<text x="${x}" y="${y}" fill="${color}" font-family="Arial, Helvetica, sans-serif" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" ${extra}>${esc(s)}</text>`;
const lines=(x,y,arr,size=58,color=C.white,weight=700,gap=1.15)=>arr.map((s,i)=>txt(x,y+i*size*gap,s,size,color,weight)).join('');
const pill=(x,y,w,label,fill=C.yellow,color=C.black)=>rect(x,y,w,48,fill,24)+txt(x+w/2,y+32,label,20,color,700,'middle');
const eyebrow=(s,light=false)=>rect(96,86,42,4,C.yellow)+txt(152,99,s.toUpperCase(),20,light?C.ink:C.muted,700,'start','letter-spacing="3"');
const footer=(n,light=false)=>line(96,1002,1824,1002,light?'#D5D1C8':C.line,1)+txt(96,1038,'JOURNEYAX  /  CONCEPT FILM',18,light?'#6A6963':C.muted,600)+txt(1824,1038,String(n).padStart(2,'0')+' / 12',18,light?'#6A6963':C.muted,600,'end');
const logo=(x=96,y=78,w=420)=>`<image href="../assets/logo-yellow.png" x="${x}" y="${y}" width="${w}" height="${w*443/2098}" preserveAspectRatio="xMidYMid meet"/>`;
const note=(s)=>txt(1820,1040,s,16,C.muted,500,'end');

const scenes=[];
function add(name,duration,body,bg=C.black){scenes.push({name,duration,markup:svg(body,bg)});}

add('01-goal',14,
  `<image href="../assets/laundry-hero.png" width="1920" height="1080" preserveAspectRatio="xMidYMid slice"/>`+
  rect(0,0,1000,1080,'url(#shade)')+
  `<defs><linearGradient id="shade"><stop stop-color="#070707" stop-opacity=".96"/><stop offset="1" stop-color="#070707" stop-opacity="0"/></linearGradient></defs>`+
  eyebrow('A better way to buy')+
  lines(96,360,['Customers arrive','with a goal.'],92)+
  txt(100,640,'“I’m renovating my laundry.”',34,C.yellow,500)+
  txt(100,910,'The journey should begin there.',29,C.white,500)+footer(1));

add('02-fragmented',13,
  eyebrow('The problem')+lines(96,235,['The experience is','still fragmented.'],78)+
  txt(98,420,'Customers jump between tools. Context gets lost.',30,C.muted,400)+
  [['Search',160],['Filters',540],['PDFs',920],['Quote form',1300]].map(([s,x],i)=>
    rect(x,575,300,185,C.raised,22,C.line,2)+circle(x+50,635,17,C.yellow)+txt(x+50,642,String(i+1),18,C.black,700,'middle')+txt(x+44,708,s,31,C.white,600)).join('')+
  line(458,666,538,666,C.muted,4,'12 10')+line(838,666,918,666,C.muted,4,'12 10')+line(1218,666,1298,666,C.muted,4,'12 10')+
  pill(97,848,423,'EVERY HANDOFF REPEATS THE WORK')+footer(2));

add('03-brand',12,
  `<defs><radialGradient id="glow"><stop stop-color="#FFD600" stop-opacity=".22"/><stop offset="1" stop-color="#FFD600" stop-opacity="0"/></radialGradient></defs>`+
  circle(960,500,600,'url(#glow)')+logo(520,228,880)+
  txt(960,575,'One continuous buying journey.',69,C.white,700,'middle')+
  txt(960,662,'Your brand’s AI salesperson, on your own site.',33,C.muted,400,'middle')+
  line(555,770,1365,770,C.yellow,3)+['Understand','Guide','Recommend','Complete'].map((s,i)=>
    circle(555+i*270,770,9,C.yellow)+txt(555+i*270,820,s,22,C.white,600,'middle')).join('')+footer(3));

add('04-human',13,
  `<image href="../assets/merchant-consult.png" width="1920" height="1080" preserveAspectRatio="xMidYMid slice"/>`+
  `<defs><linearGradient id="shade"><stop stop-color="#070707" stop-opacity=".96"/><stop offset="1" stop-color="#070707" stop-opacity="0"/></linearGradient></defs>`+
  rect(0,0,1060,1080,'url(#shade)')+eyebrow('The idea')+
  lines(96,310,['Bring the best of','consultative selling','online.'],75)+
  txt(100,690,'Remember the goal. Ask what matters.',31,C.yellow,500)+
  txt(100,735,'Explain each recommendation.',31,C.white,400)+footer(4));

const side=(active)=>rect(110,200,340,714,C.dark,25,C.line,2)+
  txt(150,260,'JourneyAX Studio',29,C.white,700)+line(150,295,405,295,C.line,2)+
  ['Overview','Business Pack','Journeys','Catalogue','Knowledge','Cards & themes','Connections','Insights'].map((s,i)=>
    (active===s?rect(132,318+i*66,296,51,C.yellow,10):'')+
    txt(151,354+i*66,s,24,active===s?C.black:C.muted,active===s?700:500)).join('');

add('05-studio',16,
  eyebrow('Merchant onboarding')+lines(96,150,['Make it your brand.'],62)+side('Business Pack')+
  rect(484,201,1320,712,C.dark,24,C.line,2)+
  txt(535,267,'Your Business Pack',50,C.white,700)+txt(536,318,'The merchant’s selling world in one place',28,C.muted,400)+
  [['Brand voice','How your assistant speaks'],['Journeys','How customers move forward'],['Catalogue','What you actually sell'],['Knowledge','What claims are supported'],['Rules','How decisions are governed'],['Cards & themes','How the experience looks']].map(([a,b],i)=>{
    const x=535+(i%3)*410,y=370+Math.floor(i/3)*224;
    return rect(x,y,370,188,C.raised,18,'#484843',1)+circle(x+37,y+43,15,C.yellow)+txt(x+66,y+53,a,29,C.white,700)+txt(x+30,y+110,b,20,C.muted,400);
  }).join('')+txt(1752,885,'Illustrative interface',18,C.muted,400,'end')+footer(5));

add('06-connect',15,
  eyebrow('Connect what you already have')+lines(96,195,['Your systems become','one guided experience.'],69)+
  [['Catalogue',170,540],['Stock & pricing',170,740],['Knowledge',620,540],['Commerce',620,740]].map(([a,x,y])=>
    rect(x,y,355,142,C.raised,19,C.line,2)+circle(x+49,y+70,19,C.yellow)+txt(x+86,y+81,a,27,C.white,600)).join('')+
  rect(1180,545,465,300,C.yellow,26)+txt(1412,625,'JOURNEYAX',24,C.ink,700,'middle','letter-spacing="2"')+
  txt(1412,706,'Go + Studio',42,C.ink,700,'middle')+txt(1412,757,'+ your Business Pack',31,C.ink,500,'middle')+
  line(1000,650,1155,650,C.yellow,5)+txt(1080,624,'→',58,C.yellow,500,'middle')+
  txt(95,945,'The Pack guides the experience; live data stays in connected systems.',20,C.muted,400)+footer(6));

const goShell=()=>rect(95,185,1730,755,C.paper,25)+rect(95,185,1730,75,C.ink,25)+
  rect(95,226,1730,34,C.ink)+txt(135,235,'JourneyAX Go',25,C.white,700)+
  txt(1768,234,'PLACEMAKERS  ·  ILLUSTRATIVE',18,C.muted,600,'end')+
  line(900,260,900,940,'#D8D3C9',2);
const chat=(messages)=>messages.map((m,i)=>{
  const y=326+i*147, user=m.role==='user', x=user?310:140,w=user?535:675;
  return rect(x,y,w,104,user?'#E7E2D7':'#FFFDF6',19,'#D8D3C9',1)+txt(x+23,y+42,m.text,25,C.ink,user?600:500)+
    (m.sub?txt(x+23,y+74,m.sub,20,'#55544F',400):'');
}).join('');

add('07-start',18,
  eyebrow('Customer experience')+txt(96,150,'Start with the customer’s goal.',62,C.white,700)+goShell()+
  chat([{role:'user',text:'I’m renovating my laundry.'},{role:'assistant',text:'Let’s plan around your space.',sub:'I’ll keep the laundry project in mind.'}])+
  rect(960,310,790,545,'#E6E0D4',20)+`<image href="../assets/laundry-hero.png" x="976" y="326" width="758" height="350" preserveAspectRatio="xMidYMid slice"/>`+
  txt(1000,736,'YOUR PROJECT',19,C.ink,700)+txt(1000,792,'Laundry renovation',43,C.ink,700)+
  txt(1000,830,'A visual workspace alongside the conversation',21,'#686761',400)+footer(7));

add('08-clarify',16,
  eyebrow('Relevant questions')+txt(96,150,'Ask only what helps the decision.',62,C.white,700)+goShell()+
  chat([{role:'user',text:'I’m renovating my laundry.'},{role:'assistant',text:'Got it — a laundry renovation.',sub:'Are the washer and dryer side by side or stacked?'}])+
  pill(960,337,235,'SIDE BY SIDE',C.yellow,C.ink)+pill(1218,337,170,'STACKED',C.white,C.ink)+
  rect(960,435,785,260,C.white,20,'#D8D3C9',1)+txt(995,498,'Remembered context',26,C.ink,700)+
  txt(995,560,'Project: laundry renovation',27,C.ink,500)+txt(995,607,'Next detail: appliance layout',27,C.ink,500)+
  txt(995,663,'No repeated room-type question.',23,'#6D6B64',400)+
  txt(961,825,'Cards appear when useful — not on every turn.',26,C.ink,600)+footer(8));

add('09-recommend',18,
  eyebrow('Grounded recommendations')+txt(96,150,'Show options. Explain why.',62,C.white,700)+goShell()+
  chat([{role:'user',text:'Side by side. I need storage too.'},{role:'assistant',text:'Here are useful starting points.',sub:'I’ve used your laundry layout and storage goal.'}])+
  [['Cabinet option','Supports the storage goal'],['Overhead storage','Adds upper storage'],['Benchtop option','Creates a work surface']].map(([a,b],i)=>{
    const x=960+i*263;
    return rect(x,334,241,437,C.white,17,'#D8D3C9',1)+rect(x+16,352,209,185,'#E8E3D8',12)+
      (i===0?rect(x+58,392,120,112,'#B69C77',6)+line(x+118,394,x+118,504,'#8A7255',3):i===1?
      rect(x+59,382,119,140,'#D7D1C5',4,'#B8B1A5',2)+line(x+70,432,x+167,432,'#A9A397',3):
      rect(x+47,407,146,80,'#B5BBB9',10)+line(x+120,374,x+120,415,'#7D8582',8))+
      txt(x+18,580,a,25,C.ink,700)+txt(x+18,626,'WHY THIS?',17,'#A37E00',700)+
      txt(x+18,659,b,18,'#5B5952',400)+rect(x+18,699,205,48,C.ink,10)+txt(x+120,730,'Review option',18,C.white,600,'middle');
  }).join('')+txt(960,841,'Illustrative categories — final items come from the merchant catalogue.',19,'#6A6963',400)+footer(9));

add('10-complete',17,
  eyebrow('From advice to action')+lines(96,195,['The journey continues','toward an outcome.'],69)+
  [['Product choice','Selected for the need'],['Verified details','Care · installation · warranty'],['Basket or quote','Ready for customer review'],['Checkout or handoff','Through the connected system']].map(([a,b],i)=>{
    const x=120+i*450;
    return rect(x,502,408,280,i===2?C.yellow:C.raised,20,i===2?'none':C.line,2)+
      circle(x+51,558,23,i===2?C.ink:C.yellow)+txt(x+51,566,String(i+1),21,i===2?C.yellow:C.ink,700,'middle')+
      txt(x+30,650,a,34,i===2?C.ink:C.white,700)+txt(x+30,696,b,22,i===2?'#36320F':C.muted,400);
  }).join('')+line(280,835,1615,835,C.yellow,4)+
  txt(96,923,'Only show claims, actions and checkout paths the merchant has actually enabled.',24,C.muted,400)+footer(10));

add('11-insights',16,
  eyebrow('Back office')+txt(96,150,'Improve the journey from Studio.',62,C.white,700)+side('Insights')+
  rect(484,201,1320,712,C.dark,24,C.line,2)+txt(537,267,'Journey insights',45,C.white,700)+
  txt(537,314,'Find friction. Improve content. Refine the path.',27,C.muted,400)+
  rect(535,372,800,468,C.raised,18,'#484843',1)+
  txt(578,430,'Illustrative journey flow',25,C.white,700)+
  [['Goal',590,720],['Clarify',760,655],['Options',930,560],['Cart / quote',1100,475]].map(([a,x,y],i)=>
    circle(x,y,13,C.yellow)+txt(x,y-36,a,20,C.white,600,'middle')+(i?line(x-170,y+([720,655,560,475][i-1]-y),x,y,C.yellow,4):'')).join('')+
  line(578,775,1276,775,C.line,2)+
  rect(1370,372,380,211,C.raised,18,'#484843',1)+txt(1404,425,'Questions to improve',22,C.white,700)+
  txt(1404,475,'Where do shoppers pause?',21,C.muted,400)+txt(1404,512,'What context is missing?',21,C.muted,400)+
  rect(1370,610,380,229,C.yellow,18)+txt(1404,668,'Merchant control',25,C.ink,700)+
  txt(1404,717,'Update journeys, content,',21,C.ink,500)+txt(1404,749,'cards and brand styling.',21,C.ink,500)+
  txt(1750,881,'Illustrative interface and chart',18,C.muted,400,'end')+footer(11));

add('12-close',12,
  `<defs><radialGradient id="g"><stop stop-color="#FFD600" stop-opacity=".16"/><stop offset="1" stop-color="#FFD600" stop-opacity="0"/></radialGradient></defs>`+
  circle(960,500,620,'url(#g)')+logo(590,164,740)+
  txt(960,483,'From first question',72,C.white,700,'middle')+
  txt(960,576,'to the next confident step.',72,C.yellow,700,'middle')+
  line(558,660,1362,660,C.yellow,3)+
  txt(960,744,'One brand. One journey. Connected to your commerce.',32,C.white,400,'middle')+
  pill(754,825,414,'EXPLORE JOURNEYAX.COM')+
  txt(960,1007,'Conceptual product film · no live customer data shown',18,C.muted,400,'middle'));

for (const [i,s] of scenes.entries()) {
  const p=join(out,`${String(i+1).padStart(2,'0')}-${s.name}.png`);
  const markup = Object.entries(embedded).reduce((value,[path,data]) => value.replaceAll(path,data),s.markup);
  await sharp(Buffer.from(markup)).resize(W,H).png().toFile(p);
}
await writeFile(join(out,'timing.json'),JSON.stringify(scenes.map((s,i)=>({scene:i+1,name:s.name,durationSeconds:s.duration})),null,2)+'\n');
const thumbs = await Promise.all(scenes.map(async (s,i)=>({
  input:await sharp(join(out,`${String(i+1).padStart(2,'0')}-${s.name}.png`)).resize(480,270).png().toBuffer(),
  left:(i%4)*480,
  top:Math.floor(i/4)*270
})));
await sharp({create:{width:1920,height:810,channels:3,background:C.black}})
  .composite(thumbs).jpeg({quality:88}).toFile(join(out,'storyboard-contact-sheet.jpg'));

if (process.argv.includes('--video')) {
  const inputs=[];
  for(let i=0;i<scenes.length;i++) inputs.push('-loop','1','-framerate','24','-t',String(scenes[i].duration),'-i',join(out,`${String(i+1).padStart(2,'0')}-${scenes[i].name}.png`));
  const filters=[];
  for(let i=0;i<scenes.length;i++) filters.push(`[${i}:v]scale=1920:1080,setsar=1,format=yuv420p[v${i}]`);
  let offset=scenes[0].duration-.65;
  filters.push(`[v0][v1]xfade=transition=fade:duration=0.65:offset=${offset.toFixed(2)}[x1]`);
  for(let i=2;i<scenes.length;i++) {
    offset+=scenes[i-1].duration-.65;
    filters.push(`[x${i-1}][v${i}]xfade=transition=fade:duration=0.65:offset=${offset.toFixed(2)}[x${i}]`);
  }
  const args=['-y',...inputs,'-filter_complex',filters.join(';'),'-map',`[x${scenes.length-1}]`,'-r','24','-c:v','libx264','-preset','veryfast','-crf','20','-pix_fmt','yuv420p','-movflags','+faststart',join(out,'journeyax-promo-silent.mp4')];
  const p=spawnSync('ffmpeg',args,{stdio:'inherit'});
  if(p.status!==0) process.exit(p.status??1);
}
