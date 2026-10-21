const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });
app.get('/', (_req, res) => res.send('BLUE DOOM online server is running'));
app.get('/health', (_req, res) => res.json({ ok: true, game: 'BLUE DOOM' }));
const rooms = new Map();
function code(){ let s=''; const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; for(let i=0;i<6;i++) s+=chars[Math.floor(Math.random()*chars.length)]; return s; }
function publicState(p){ return p && p.state ? p.state : {x:p.slot===1?2.5:13.5,y:p.slot===1?2.5:9.5,a:0,hp:p.hp,floor:0,weapon:'ak'}; }
function roomOf(socket){ return socket.data.room ? rooms.get(socket.data.room) : null; }
function findPlayer(room,socket){ return room && room.players.find(p=>p && p.id===socket.id); }
function opponent(room,socket){ return room && room.players.find(p=>p && p.id!==socket.id); }
function emitRoundStart(room){
  room.roundOver=false;
  for(const p of room.players){ if(p){ p.hp=100; p.state=null; } }
  io.to(room.code).emit('round-start',{round:room.round,scores:room.scores.slice()});
}
function endRound(room,winnerSlot){
  if(!room || room.roundOver) return;
  room.roundOver=true;
  room.scores[winnerSlot-1]++;
  io.to(room.code).emit('round-end',{round:room.round,winnerSlot,scores:room.scores.slice()});
  if(room.round>=10){
    setTimeout(()=>{
      if(!rooms.has(room.code))return;
      const winnerSlot=room.scores[0]===room.scores[1]?0:(room.scores[0]>room.scores[1]?1:2);
      io.to(room.code).emit('match-end',{winnerSlot,scores:room.scores.slice(),rounds:10});
    },1800);
  } else {
    setTimeout(()=>{ if(!rooms.has(room.code))return; room.round++; emitRoundStart(room); },2600);
  }
}
io.on('connection', socket => {
  socket.on('create', () => {
    let c; do { c=code(); } while(rooms.has(c));
    const room={code:c,players:[null,null],round:1,scores:[0,0],roundOver:false};
    const p={id:socket.id,slot:1,hp:100,state:null}; room.players[0]=p; rooms.set(c,room); socket.data.room=c; socket.data.slot=1; socket.join(c);
    socket.emit('room',{code:c});
  });
  socket.on('join', data => {
    const c=String(data&&data.code||'').toUpperCase(); const room=rooms.get(c);
    if(!room){socket.emit('room-error',{message:'Комната не найдена. Проверь код.'});return;}
    if(room.players[1]){socket.emit('room-error',{message:'Комната уже заполнена.'});return;}
    const p={id:socket.id,slot:2,hp:100,state:null}; room.players[1]=p; socket.data.room=c; socket.data.slot=2; socket.join(c);
    const a=room.players[0],b=room.players[1];
    io.to(a.id).emit('ready',{code:c,slot:1,round:room.round,scores:room.scores.slice(),opponent:publicState(b)});
    io.to(b.id).emit('ready',{code:c,slot:2,round:room.round,scores:room.scores.slice(),opponent:publicState(a)});
  });
  socket.on('state', data => {
    const room=roomOf(socket),p=findPlayer(room,socket),o=opponent(room,socket);
    if(!p||!o||room.roundOver||!data)return;
    const x=Number(data.x),y=Number(data.y),a=Number(data.a);
    if(!Number.isFinite(x)||!Number.isFinite(y)||!Number.isFinite(a))return;
    p.state={x:Math.max(0,Math.min(40,x)),y:Math.max(0,Math.min(40,y)),a,hp:p.hp,floor:Number(data.floor)||0,weapon:typeof data.weapon==='string'?data.weapon.slice(0,12):'ak'};
    io.to(o.id).emit('state',p.state);
  });
  socket.on('hit', data => {
    const room=roomOf(socket),attacker=findPlayer(room,socket),target=opponent(room,socket);
    if(!room||!attacker||!target||room.roundOver||!data)return;
    const damage=Math.max(1,Math.min(100,Math.round(Number(data.damage)||0)));
    target.hp=Math.max(0,target.hp-damage);
    io.to(target.id).emit('hit',{hp:target.hp,damage,by:attacker.slot,source:data.source==='grenade'?'grenade':'weapon'});
    if(target.hp<=0)endRound(room,attacker.slot);
  });
  socket.on('shoot', data => {
    const room=roomOf(socket),p=findPlayer(room,socket),o=opponent(room,socket);
    if(!room||!p||!o||room.roundOver||!data)return;
    const a=Number(data.a); if(!Number.isFinite(a))return;
    io.to(o.id).emit('opponent-shoot',{a,x:Number(data.x)||0,y:Number(data.y)||0,weapon:typeof data.weapon==='string'?data.weapon:'ak',floor:Number(data.floor)||0});
  });
  socket.on('grenade', data => {
    const room=roomOf(socket),p=findPlayer(room,socket),o=opponent(room,socket);
    if(!room||!p||!o||room.roundOver||!data)return;
    const x=Number(data.x),y=Number(data.y);if(!Number.isFinite(x)||!Number.isFinite(y))return;
    const clean={x,y,floor:Number(data.floor)||0,z:Number(data.z)||.45,vx:Number(data.vx)||0,vy:Number(data.vy)||0,vz:Number(data.vz)||0,fuse:Math.max(.1,Math.min(3,Number(data.fuse)||1.75))};
    io.to(o.id).emit('opponent-grenade',clean);
  });
  socket.on('respawn',()=>{});
  socket.on('disconnect',()=>{
    const room=roomOf(socket); if(!room)return;
    const idx=room.players.findIndex(p=>p&&p.id===socket.id); if(idx>=0)room.players[idx]=null;
    socket.to(room.code).emit('opponent-left');
    if(room.players.every(p=>!p))rooms.delete(room.code);
    else if(!room.players[0]||!room.players[1]){ /* keep room alive for reconnect-free host use */ }
  });
});
const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`BLUE DOOM server listening on ${PORT}`));
