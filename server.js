const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });
const rooms = new Map();
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeCode(){ let code; do { code=''; for(let i=0;i<5;i++) code+=alphabet[crypto.randomInt(alphabet.length)]; } while(rooms.has(code)); return code; }
app.get('/', (_req,res)=>res.type('text').send('BLUE DOOM multiplayer server is running.'));
app.get('/health', (_req,res)=>res.json({ok:true,rooms:rooms.size}));
function sendError(socket,message){ socket.emit('room-error',{message}); }
io.on('connection',socket=>{
 socket.on('create',()=>{
  if(socket.data.room) leave(socket);
  const code=makeCode(); rooms.set(code,{players:[socket.id],states:{},hp:{[socket.id]:100}}); socket.data.room=code; socket.data.slot=1; socket.join(code); socket.emit('room',{code});
 });
 socket.on('join',({code}={})=>{
  code=String(code||'').toUpperCase().replace(/[^A-Z0-9]/g,''); const room=rooms.get(code);
  if(!room){sendError(socket,'Комната не найдена. Проверь код.');return;}
  if(room.players.length>=2){sendError(socket,'В комнате уже два игрока.');return;}
  if(socket.data.room)leave(socket);
  room.players.push(socket.id);room.hp[socket.id]=100;socket.data.room=code;socket.data.slot=2;socket.join(code);
  const a=io.sockets.sockets.get(room.players[0]);
  if(a){a.emit('ready',{code,slot:1,opponent:room.states[room.players[1]]||{x:3.5,y:2.5,a:Math.PI,hp:100,floor:0}});}
  socket.emit('ready',{code,slot:2,opponent:room.states[room.players[0]]||{x:2.5,y:2.5,a:0,hp:100,floor:0}});
 });
 socket.on('state',state=>{const code=socket.data.room,room=rooms.get(code);if(!room||!room.players.includes(socket.id)||!state)return;
  const clean={x:num(state.x,2.5,0,100),y:num(state.y,2.5,0,100),a:num(state.a,0,-100,100),hp:room.hp[socket.id]??100,floor:num(state.floor,0,0,10),weapon:String(state.weapon||'ak').slice(0,12)};
  room.states[socket.id]=clean; socket.to(code).emit('state',clean);
 });
 socket.on('hit',({damage}={})=>{const code=socket.data.room,room=rooms.get(code);if(!room||!room.players.includes(socket.id))return;
  const targetId=room.players.find(id=>id!==socket.id);if(!targetId)return;
  const d=Math.max(1,Math.min(100,Number(damage)||0));room.hp[targetId]=Math.max(0,(room.hp[targetId]??100)-d);
  io.to(targetId).emit('hit',{hp:room.hp[targetId]});
  if(room.states[targetId])room.states[targetId].hp=room.hp[targetId];
 });
 socket.on('respawn',()=>{const code=socket.data.room,room=rooms.get(code);if(!room)return;room.hp[socket.id]=100;socket.emit('hit',{hp:100});});
 socket.on('disconnect',()=>leave(socket));
 function leave(s){const code=s.data.room;if(!code)return;const room=rooms.get(code);if(room){room.players=room.players.filter(id=>id!==s.id);delete room.states[s.id];delete room.hp[s.id];for(const id of room.players)io.to(id).emit('opponent-left');if(room.players.length===0)rooms.delete(code);}s.data.room=null;}
});
function num(v,def,min,max){v=Number(v);return Number.isFinite(v)?Math.max(min,Math.min(max,v)):def;}
const port=process.env.PORT||3000;server.listen(port,'0.0.0.0',()=>console.log(`BLUE DOOM server listening on ${port}`));
