import assert from 'node:assert/strict';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
/** Uses real Chromium wheel/touch input; no scrollTop assignment proves a pass. */
export async function verifyActivityScroll(browser,root,{mobile=false}={}){
 const {call,evaluate,wait}=browser;
 const stats=()=>evaluate(`(()=>{const r=${root},v=r.querySelector('.viewport'),h=r.host,a=r.querySelector('#ac-app');return {client:v.clientHeight,scroll:v.scrollHeight,top:v.scrollTop,screen:innerHeight,host:h.getBoundingClientRect().height,app:a.getBoundingClientRect().height,rect:{x:v.getBoundingClientRect().left+v.clientWidth/2,y:Math.min(innerHeight-120,v.getBoundingClientRect().top+v.clientHeight*.72)}};})()`);
 await wait(root+"?.querySelector('.viewport')!==null");const initial=await stats();assert(initial.client<=initial.host+1&&initial.app<=initial.host+1,'Scroll height must be bounded by the DSH host');assert(initial.scroll>initial.client+100,'Need real overflowing content');
 const {x,y}=initial.rect;
 if(mobile){
  await call('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,id:1}]});
  for(const d of [30,90,170,260,360]){await call('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y-d,id:1}]});await sleep(45);}
  await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 }else await call('Input.dispatchMouseEvent',{type:'mouseWheel',x,y,deltaX:0,deltaY:600});
 await sleep(600);const down=await stats();assert(down.top>initial.top+20,mobile?'Touch must move the actual inner viewport':'Wheel must move the actual inner viewport');
 if(!mobile){await call('Input.dispatchMouseEvent',{type:'mouseWheel',x,y,deltaX:0,deltaY:-300});await sleep(300);const up=await stats();assert(up.top<down.top,'Wheel up must work');await call('Input.dispatchMouseEvent',{type:'mouseWheel',x,y,deltaX:0,deltaY:initial.scroll+1000});await sleep(400);const bottom=await stats();assert(Math.abs(bottom.top+bottom.client-bottom.scroll)<=2,'The bottom must be reachable');
  const beforeRefresh=bottom.top;await evaluate(`${root}.querySelector('[data-action=refresh]').click()`);await wait(root+"?.querySelector('[data-action=refresh]')?.textContent==='刷新视图'");const refreshed=await stats();assert(Math.abs(refreshed.top-beforeRefresh)<=2,'Read refresh must preserve scroll position');return {input:'wheel',initial,down,up,bottom,refreshPreserved:true};
 }
 return {input:'touch',initial,down};
}
