import { createServer } from 'node:http';

createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/plain' });
  response.end('Hello from a fresh clone!\n');
}).listen(3000, '0.0.0.0', () => console.log('Ready on port 3000'));
