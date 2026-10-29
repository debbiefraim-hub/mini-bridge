const express=require('express');
const path=require('path');
const crypto=require('crypto');
const http=require('http');
const {Server}=require('socket.io');
const app=express(),server=http.createServer(app),io=new Server(server);
app.use(express.static(path.join(__dirname,'public')));
const rooms=new Map();
// Administrator dashboard: never expose this data without the server-side password.
function requireAdmin(req,res,next){
 res.set('Cache-Control','no-store');
 const configured=process.env.ADMIN_PASSWORD;
 if(!configured || configured.length<12)return res.status(503).type('text/plain').send('Admin dashboard is not configured. Set ADMIN_PASSWORD (12+ characters) in Render.');
 const header=req.get('authorization')||'';
 let credentials='';
 if(header.startsWith('Basic ')){
  try{credentials=Buffer.from(header.slice(6),'base64').toString('utf8');}catch(e){}
 }
 const expected='admin:'+configured;
 const a=Buffer.from(credentials),b=Buffer.from(expected);
 if(a.length!==b.length||!crypto.timingSafeEqual(a,b)){
  res.set('WWW-Authenticate','Basic realm="Mini Bridge Admin", charset="UTF-8"');
  return res.status(401).send('Authentication required');
 }
 next();
}
function adminSnapshot(){
 const list=Array.from(rooms.values()).map(g=>({
  code:g.code,round:g.round,phase:g.phase,paused:!!g.paused,
  connected:g.players.filter(p=>!!p.socket).length,
  players:g.players.length
 }));
 const live=list.filter(g=>g.phase!=='finished');
 return {time:new Date().toISOString(),rooms:live.length,
  waiting:live.filter(g=>g.phase==='lobby').length,
  playing:live.filter(g=>g.phase!=='lobby'&&!g.paused).length,
  paused:live.filter(g=>g.paused).length,
  connected:live.reduce((n,g)=>n+g.connected,0),
  finished:list.length-live.length,
  list};
}
app.get('/admin',requireAdmin,(req,res)=>res.sendFile(path.join(__dirname,'admin.html')));
app.get('/admin/api/status',requireAdmin,(req,res)=>res.json(adminSnapshot()));
const suits=['♠','♥','♦','♣'];
function deck(){return suits.flatMap(s=>Array.from({length:13},(_,i)=>({s,r:i+2})));}
function shuffle(a){for(let i=a.length-1;i>0;i--){let j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
function err(sock,msg){sock.emit('errorMessage',msg);}
function publicState(g){return {code:g.code,seen:g.seen||[],players:g.players.map((p,i)=>({name:p.name,seat:i,connected:!!p.socket,score:p.score,bid:p.bid,tricks:p.tricks,count:p.hand.length})),round:g.round,phase:g.phase,trump:g.trump,turn:g.turn,leader:g.leader,table:g.table,history:g.history,roundRecords:g.roundRecords||[],startedAt:g.startedAt||null,first:g.first,ready:g.ready,finished:g.finished,paused:g.paused||false,endedEarly:g.endedEarly||false};}
function emit(g){const pub=publicState(g);g.players.forEach((p,i)=>{if(p.socket)io.to(p.socket).emit('state',{...pub,seat:i,isHost:p.token===g.hostId,hand:p.hand});});}
function startRound(g){g.round++;if(g.round>13){g.phase='finished';g.finished=true;emit(g);return;}const d=shuffle(deck());g.players.forEach(p=>{p.hand=d.splice(0,g.round);p.bid=null;p.tricks=0;});g.trump=g.round===13?null:d.pop().s;g.first=(g.round-1)%4;g.turn=g.first;g.leader=g.first;g.phase='bid';g.table=[];g.history=[];g.seen=[];g.ready=false;emit(g);}
function settle(g,keepTrick=false){if(!g.roundRecords)g.roundRecords=[];if(g.roundRecords.some(x=>x.round===g.round))return;g.roundRecords.push({round:g.round,players:g.players.map(p=>({bid:p.bid,tricks:p.tricks}))});g.players.forEach(p=>{const earned=p.bid===p.tricks?10+p.bid*p.bid:p.tricks;p.score+=earned;});if(!keepTrick)g.phase='summary';g.ready=true;}
function winning(g){const lead=g.table[0].card.s;let win=g.table[0];for(const t of g.table.slice(1)){const a=t.card,b=win.card;if((a.s===b.s&&a.r>b.r)||(g.trump&&a.s===g.trump&&b.s!==g.trump))win=t;}return win.seat;}
const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function code(){let s;do{s=Array.from({length:5},()=>chars[Math.floor(Math.random()*chars.length)]).join('');}while(rooms.has(s));return s;}
io.on('connection',socket=>{
 socket.on('create',({name},cb)=>{name=String(name||'').trim().slice(0,24);if(!name)return cb({error:'יש להזין שם'});const c=code(),token=crypto.randomBytes(24).toString('hex'),g={code:c,hostId:token,players:[{name,socket:socket.id,token,score:0,hand:[],bid:null,tricks:0}],round:0,phase:'lobby',trump:null,turn:0,leader:0,table:[],history:[],roundRecords:[],startedAt:null,first:0,ready:false,finished:false,paused:false,endedEarly:false};rooms.set(c,g);socket.join(c);socket.data={code:c,seat:0};cb({code:c,token});emit(g);});
 socket.on('join',({name,code:c},cb)=>{c=String(c||'').toUpperCase().trim();name=String(name||'').trim().slice(0,24);const g=rooms.get(c);if(!g)return cb({error:'החדר לא נמצא'});if(g.phase!=='lobby'||g.players.length===4)return cb({error:'החדר כבר התחיל או מלא'});if(!name)return cb({error:'יש להזין שם'});const seat=g.players.length,token=crypto.randomBytes(24).toString('hex');g.players.push({name,socket:socket.id,token,score:0,hand:[],bid:null,tricks:0});socket.join(c);socket.data={code:c,seat};cb({code:c,token});emit(g);});
 socket.on('start',()=>{const g=rooms.get(socket.data?.code);if(!g||g.players[socket.data.seat]?.token!==g.hostId)return;if(g.players.length!==4)return err(socket,'נדרשים ארבעה שחקנים');if(g.phase!=='lobby')return;shuffle(g.players);g.players.forEach((p,i)=>{const s=io.sockets.sockets.get(p.socket);if(s)s.data.seat=i;});g.startedAt=new Date().toISOString();startRound(g);});
 socket.on('bid',value=>{const g=rooms.get(socket.data?.code),seat=socket.data?.seat;if(!g||g.paused||g.phase!=='bid'||seat!==g.turn||g.players[seat]?.socket!==socket.id)return;const n=Number(value);if(!Number.isInteger(n)||n<0||n>g.round)return err(socket,'הכרזה לא חוקית');if(g.round>=5&&seat===(g.first+3)%4){const sum=g.players.reduce((s,p)=>s+(p.bid??0),0);if(sum+n===g.round)return err(socket,'הכרזה זו אסורה למכריז האחרון');}g.players[seat].bid=n;const next=(seat+1)%4;if(next===g.first){g.phase='play';g.turn=g.first;}else g.turn=next;emit(g);});
 socket.on('play',index=>{const g=rooms.get(socket.data?.code),seat=socket.data?.seat;if(!g||g.paused||g.phase!=='play'||g.turn!==seat||g.players[seat]?.socket!==socket.id)return;const p=g.players[seat],idx=Number(index);if(!Number.isInteger(idx)||idx<0||idx>=p.hand.length)return;const card=p.hand[idx],lead=g.table[0]?.card.s;if(lead&&card.s!==lead&&p.hand.some(c=>c.s===lead))return err(socket,'חובה לשחק קלף מהסדרה הפותחת');p.hand.splice(idx,1);g.table.push({seat,card});if(g.table.length===4){const winner=winning(g);g.players[winner].tricks++;g.history.push({cards:g.table.map(x=>({...x})),winner});g.phase='trick';g.turn=winner;g.leader=winner;g.seen=[];if(g.players.every(p=>p.hand.length===0))settle(g,true);emit(g);}else{g.turn=(seat+1)%4;emit(g);}});
 socket.on('seen',()=>{const g=rooms.get(socket.data?.code),seat=socket.data?.seat;if(!g||g.paused||g.phase!=='trick'||!Number.isInteger(seat)||g.players[seat]?.socket!==socket.id)return;if(!g.seen.includes(seat))g.seen.push(seat);if(g.seen.length===4){g.table=[];g.seen=[];if(g.players.every(p=>p.hand.length===0)){startRound(g);}else{g.phase='play';emit(g);}}else emit(g);});
 socket.on('pause',()=>{const g=rooms.get(socket.data?.code),seat=socket.data?.seat;if(!g||g.finished||g.players[seat]?.token!==g.hostId)return;g.paused=true;emit(g);});
 socket.on('resume',()=>{const g=rooms.get(socket.data?.code),seat=socket.data?.seat;if(!g||!g.paused||g.players[seat]?.token!==g.hostId)return;if(g.players.length!==4||g.players.some(p=>!p.socket))return err(socket,'יש להמתין לחיבור כל ארבעת השחקנים');g.paused=false;emit(g);});
 socket.on('endGame',()=>{const g=rooms.get(socket.data?.code),seat=socket.data?.seat;if(!g||g.finished||g.players[seat]?.token!==g.hostId)return;g.finished=true;g.endedEarly=true;g.paused=false;g.phase='finished';emit(g);});
 socket.on('leaveFinished',()=>{const c=socket.data?.code,seat=socket.data?.seat,g=rooms.get(c);if(!g||g.phase!=='finished'||g.players[seat]?.socket!==socket.id)return;g.players[seat].socket=null;socket.leave(c);socket.data={};if(g.players.every(p=>!p.socket))rooms.delete(c);else emit(g);});
 socket.on('disconnect',()=>{const g=rooms.get(socket.data?.code),seat=socket.data?.seat;if(g&&g.players[seat]?.socket===socket.id){g.players[seat].socket=null;emit(g);}});
 socket.on('rejoin',({code:c,token},cb)=>{const g=rooms.get(String(c||'').toUpperCase());if(!g)return cb({error:'החדר אינו פעיל (ייתכן שהשרת הופעל מחדש)'});const seat=g.players.findIndex(p=>p.token===token);if(seat<0)return cb({error:'פרטי החזרה לחדר אינם תקינים'});const old=g.players[seat].socket;if(old&&old!==socket.id){const previous=io.sockets.sockets.get(old);if(previous){previous.emit('replaced','החיבור נפתח במכשיר או בכרטיסייה אחרת');previous.leave(g.code);previous.data={};}}g.players[seat].socket=socket.id;socket.data={code:g.code,seat};socket.join(g.code);cb({code:g.code,token});emit(g);});
});
server.listen(process.env.PORT||3000,()=>console.log('Mini Bridge on port '+(process.env.PORT||3000)));
