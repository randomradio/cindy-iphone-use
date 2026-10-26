'use strict';
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const path = require('node:path');
const MAX_LINE = 12 * 1024 * 1024;
class MCPBridge {
  constructor({ launch, timeout = 90000, maxLine = MAX_LINE } = {}) {
    this.launch = launch || (() => spawn('python3', ['-B', '-u', path.join(__dirname, '../upstream/server/cindy_entry.py')], {
      stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PATH: [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean).join(':'), PYTHONDONTWRITEBYTECODE: '1' }
    }));
    this.timeout = timeout; this.maxLine = maxLine; this.next = 0; this.pending = new Map(); this.child = null; this.initializing = null;
  }
  start() {
    if (this.initializing) return this.initializing;
    const child = this.child = this.launch(); let buffer = ''; const decoder = new StringDecoder('utf8');
    const failed = () => { if (this.child === child) this.close(new Error('Python bridge stopped. Reopen the panel; do not repeat uncertain phone actions.')); };
    child.on('error', failed); child.on('exit', failed); child.stdin.on('error', failed);
    // Upstream stderr may contain personal information. Drain, never forward or log it.
    child.stderr.on('data', () => {});
    child.stdout.on('data', chunk => {
      if (this.child !== child) return;
      buffer += decoder.write(chunk);
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (Buffer.byteLength(line) > this.maxLine) { this.close(new Error('Python response exceeds the transport limit.')); return; }
        let msg; try { msg = JSON.parse(line); } catch { this.close(new Error('Invalid Python bridge response.')); return; }
        const pending = this.pending.get(msg.id);
        if (!pending) continue;
        clearTimeout(pending.timer); this.pending.delete(msg.id);
        if (msg.error) pending.reject(new Error('Python request failed; inspect adapter configuration.'));
        else pending.resolve(msg.result);
      }
      if (Buffer.byteLength(buffer) > this.maxLine) this.close(new Error('Python response exceeds the transport limit.'));
    });
    this.initializing = this.raw('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'cindy-iphone-use', version: '0.1.0' } }, 10000)
      .then(() => { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'); })
      .catch(error => { this.close(error); throw error; });
    return this.initializing;
  }
  raw(method, params, timeout = this.timeout) {
    if (this.pending.size >= 24) return Promise.reject(new Error('Bridge busy. Wait for the current operation.'));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (pending) pending.timedOut = true;
        // Retain correlation until the late response arrives; block new writes meanwhile.
        reject(new Error('Phone result timed out; outcome unknown. Observe before any further action.'));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', error => {
        if (error && this.pending.has(id)) { clearTimeout(timer); this.pending.delete(id); reject(new Error('Python bridge unavailable.')); }
      });
    });
  }
  get uncertain() { return [...this.pending.values()].some(p => p.timedOut); }
  async call(name, args = {}, timeout) { await this.start(); return this.raw('tools/call', { name, arguments: args }, timeout); }
  close(error = new Error('Bridge closed.')) {
    const child = this.child; this.child = null; this.initializing = null;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    if (child) { child.stdin.end(); child.kill('SIGTERM'); }
  }
}
module.exports = { MCPBridge, MAX_LINE };
