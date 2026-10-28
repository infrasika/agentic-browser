// TLS-only capture server. Used exclusively with synthetic accounts in isolated acceptance.
import { createServer } from 'node:tls';
import { createServer as httpServer } from 'node:http';
import { readFileSync } from 'node:fs';
const messages = [];
createServer({key:readFileSync('/fixtures/mail.key'),cert:readFileSync('/fixtures/mail.crt')}, socket => {
  socket.setEncoding('utf8'); socket.write('220 fixture ESMTP\r\n');
  let buffer='', data=false, message=[];
  socket.on('error',()=>{});
  socket.on('data', chunk => {
    buffer+=chunk;
    while(buffer.includes('\r\n')) {
      const i=buffer.indexOf('\r\n'), line=buffer.slice(0,i); buffer=buffer.slice(i+2);
      if(data) { if(line==='.') { messages.push(message.join('\r\n')); data=false; message=[]; socket.write('250 accepted\r\n'); } else message.push(line); continue; }
      if(/^EHLO|^HELO/.test(line)) socket.write('250-fixture\r\n250 SIZE 1048576\r\n');
      else if(/^DATA/.test(line)) { data=true; socket.write('354 send data\r\n'); }
      else if(/^QUIT/.test(line)) { socket.end('221 goodbye\r\n'); }
      else socket.write('250 OK\r\n');
    }
  });
}).listen(2525,'0.0.0.0');
httpServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({messages}));}).listen(9001,'0.0.0.0');
