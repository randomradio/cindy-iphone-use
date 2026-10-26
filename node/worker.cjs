'use strict';
const { Service } = require('./service.cjs');
const { StringDecoder } = require('node:string_decoder');
const service = new Service();
const decoder = new StringDecoder('utf8'); let buffer = ''; let active = 0;
function reply(id, result, error) {
  const line = JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error: { code: -32000, message: error.message } } : { result }) });
  if (Buffer.byteLength(line) > 900000) return reply(id, null, new Error('Response too large. Request a smaller observation.'));
  process.stdout.write(line + '\n');
}
process.stdin.on('data', chunk => {
  buffer += decoder.write(chunk); let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    if (Buffer.byteLength(line) > 256 * 1024) { reply(null, null, new Error('Request too large.')); continue; }
    let request; try { request = JSON.parse(line); } catch { reply(null, null, new Error('Invalid JSON.')); continue; }
    if (!Object.hasOwn(request, 'id')) continue;
    if (active >= 24) { reply(request.id, null, new Error('Worker busy.')); continue; }
    active++;
    Promise.resolve().then(() => service.handle(request.method, request.params)).then(
      result => reply(request.id, result), error => reply(request.id, null, error)
    ).finally(() => active--);
  }
  if (Buffer.byteLength(buffer) > 256 * 1024) { service.close(); process.exit(1); }
});
function stop() { service.close(); process.exit(0); }
process.stdin.on('end', stop); process.on('SIGTERM', stop); process.on('SIGINT', stop);
