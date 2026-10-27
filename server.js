const express=require('express');
const path=require('path');
const crypto=require('crypto');
const http=require('http');
const {Server}=require('socket.io');
const app=express(),server=http.createServer(app),io=new Server(server);
app.use(express.static(path.join(__dirname,'public')));
const rooms=new Map();
const suits=['♠','♥','♦','♣'];
function deck(){return suits.flatMap(s=>Array.from({length:13},(_,i)=>({s,r:i+2})));}
function shuffle(a){for(let i=a.length-1;i>0;i--){let j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
function err(sock,msg){sock.emit('errorMessage',msg);}
function publicState(g){return {code:g.code,seen:g.seen||[],players:g.players.map((p,i)=>({name:p.name,seat:i,connected:!!p.socket,score:p.score,bid:p.bid,tricks:p.tricks,count:p.hand.length})),round:g.round,phase:g.phase,trump:g.trump,turn:g.turn,leader:g.leader,table:g.table,history:g.history,first:g.first,ready:g.ready,finished:g.finished};}
function emit(g){const pub=publicState(g);g.players.forEach((p,i)=>{if(p.socket)io.to(p.socket).emit('state',{...pub,seat:i,isHost:p.token===g.hostId,hand:p.hand});});}
function startRound(g){g.round++;if(g.round>13){g.phase='finished';g.finished=true;emit(g);return;}const d=shuffle(deck());g.players.forEach(p=>{p.hand=d.splice(0,g.round);p.bid=null;p.tricks=0;});g.trump=g.round===13?null:d.pop().s;g.first=(g.round-1)%4;g.turn=g.first;g.leader=g.first;g.phase='bid';g.table=[];g.history=[];g.seen=[];g.ready=false;emit(g);}
function settle(g){g.players.forEach(p=>{const earned=p.bid===p.tricks?10+p.bid*p.bid:p.tricks;p.score+=earned;});g.phase='summary';g.ready=true;emit(g);}
function winning(g){const lead=g.table[0].card.s;let win=g.table[0];for(const t of g.table.slice(1)){const a=t.card,b=win.card;if((a.s===b.s&&a.r>b.r)||(g.trump&&a.s===g.trump&&b.s!==g.trump))win=t;}return win.seat;}
const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function code(){let s;do{s=Array.from({length:5},()=>chars[Math.floor(Math.random()*chars.length)]).join('');}while(rooms.has(s));return s;}
io.on('connection',socket=>{
 socket.on('create',({name},cb)=>{name=String(name||'').trim().slice(0,24);if(!name)return cb({error:'יש להזין שם'});const c=code(),token=crypto.randomBytes(24).toString('hex'),g={code:c,hostId:token,players:[{name,socket:socket.id,token,score:0,hand:[],bid:null,tricks:0}],round:0,phase:'lobby',trump:null,turn:0,leader:0,table:[],history:[],first:0,ready:false,finished:false};rooms.set(c,g);socket.join(c);socket.data={code:c,seat:0};cb({code:c,token});emit(g);});
 socket.on('join',({name,code:c},cb)=>{c=String(c||'').toUpperCase().trim();name=String(name||'').trim().slice(0,24);const g=rooms.get(c);if(!g)return cb({error:'החדר לא נמצא'});if(g.phase!=='lobby'||g.players.length===4)return cb({error:'החדר כבר התחיל או מלא'});if(!name)return cb({error:'יש להזין שם'});const seat=g.players.length,token=crypto.randomBytes(24).toString('hex');g.players.push({name,socket:socket.id,token,score:0,hand:[],bid:null,tricks:0});socket.join(c);socket.data={code:c,seat};cb({code:c,token});emit(g);});
 socket.on('start',()=>{const g=rooms.get(socket.data?.code);if(!g||g.players[socket.data.seat]?.token!==g.hostId)return;if(g.players.length!==4)return err(socket,'נדרשים ארבעה שחקנים');if(g.phase!=='lobby')return;shuffle(g.players);g.players.forEach((p,i)=>{const s=io.sockets.sockets.get(p.socket);if(s)s.data.seat=i;});startRound(g);});
 socket.on('bid',value=>{const g=rooms.get(socket.data?.code),seat=socket.data?.seat;if(!g||g.phase!=='bid'||seat!==g.turn)return;const n=Number(value);if(!Number.isInteger(n)||n<0||n>g.round)return err(socket,'הכרזה לא חוקית');if(g.round>=5&&seat===(g.first+3)%4){const sum=g.players.reduce((s,p)=>s+(p.bid??0),0);if(sum+n===g.round)return err(socket,'הכרזה זו אסורה למכריז האחרון');}g.players[seat].bid=n;const next=(seat+1)%4;if(next===g.first){g.phase='play';g.turn=g.first;}else g.turn=next;emit(g);});
 socket.on('play',index=>{const g=rooms.get(socket.data?.code),seat=socket.data?.seat;if(!g||g.phase!=='play'||g.turn!==seat)return;const p=g.players[seat],idx=Number(index);if(!Number.isInteger(idx)||idx<0||idx>=p.hand.length)return;const card=p.hand[idx],lead=g.table[0]?.card.s;if(lead&&card.s!==lead&&p.hand.some(c=>c.s===lead))return err(socket,'חובה לשחק קלף מהסדרה הפותחת');p.hand.splice(idx,1);g.table.push({seat,card});if(g.table.length===4){const winner=winning(g);g.players[winner].tricks++;g.history.push({cards:g.table.map(x=>({...x})),winner});g.phase='trick';g.turn=winner;g.leader=winner;g.seen=[];emit(g);}else{g.turn=(seat+1)%4;emit(g);}});
 socket.on('seen',()=>{const g=rooms.get(socket.data?.code),seat=socket.data?.seat;if(!g||g.phase!=='trick'||!Number.isInteger(seat)||g.players[seat]?.socket!==socket.id)return;if(!g.seen.includes(seat))g.seen.push(seat);if(g.seen.length===4){g.table=[];g.seen=[];if(g.players.every(p=>p.hand.length===0))settle(g);else{g.phase='play';emit(g);}}else emit(g);});
 socket.on('next',()=>{const g=rooms.get(socket.data?.code),seat=socket.data?.seat;if(!g||g.phase!=='summary'||g.players[seat]?.token!==g.hostId)return;startRound(g);});
 socket.on('disconnect',()=>{const g=rooms.get(socket.data?.code),seat=socket.data?.seat;if(g&&g.players[seat]?.socket===socket.id){g.players[seat].socket=null;emit(g);}});
 socket.on('rejoin',({code:c,token},cb)=>{const g=rooms.get(String(c||'').toUpperCase());if(!g)return cb({error:'החדר אינו פעיל (ייתכן שהשרת הופעל מחדש)'});const seat=g.players.findIndex(p=>p.token===token);if(seat<0)return cb({error:'פרטי החזרה לחדר אינם תקינים'});const old=g.players[seat].socket;if(old&&old!==socket.id){const previous=io.sockets.sockets.get(old);if(previous){previous.emit('replaced','החיבור נפתח במכשיר או בכרטיסייה אחרת');previous.leave(g.code);previous.data={};}}g.players[seat].socket=socket.id;socket.data={code:g.code,seat};socket.join(g.code);cb({code:g.code,token});emit(g);});
});
server.listen(process.env.PORT||3000,()=>console.log('Mini Bridge on port '+(process.env.PORT||3000)));
