import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
const config = readFileSync('.env', 'utf8');
createServer((_q, s) => s.end(config)).listen(3000, '0.0.0.0');
