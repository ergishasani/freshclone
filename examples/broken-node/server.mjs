import { existsSync } from 'node:fs';
import { createServer } from 'node:http';

if (!existsSync('.env')) {
  console.error('Required configuration file ".env" was not found.');
  process.exit(1);
}
createServer((_request, response) => response.end('Configured!\n')).listen(3000, '0.0.0.0');
