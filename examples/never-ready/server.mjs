import { createServer } from 'node:http';
createServer((_q, s) => {
  s.writeHead(503);
  s.end('waiting for a dependency that never becomes ready');
}).listen(3000, '0.0.0.0');
