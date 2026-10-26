'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { MCPBridge } = require('./bridge.cjs');
const CHUNK = 24 * 1024, MAX_TRANSFER = 8 * 1024 * 1024;
const WRITES = new Set(['tap', 'swipe', 'type_text', 'press_button', 'launch_app', 'screen']);
const MODEL_TOOLS = new Set(['ready', 'observe', 'find', 'tap', 'swipe', 'type_text', 'press_button', 'launch_app', 'wait', 'apps', 'screen']);
function unpack(result) {
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.find(item => item.type === 'text')?.text;
  return text ? JSON.parse(text) : {};
}
class Service {
  constructor({ bridge = new MCPBridge(), ledgerDir = path.join(os.homedir(), '.local/share/cindy-iphone-use') } = {}) {
    this.bridge = bridge; this.transfers = new Map(); this.ledgerDir = ledgerDir; this.actions = new Map();
    this.epoch = crypto.randomBytes(16).toString('hex'); this.mutating = false; this.needsObservation = false;
    this.ledger = {};
    try { this.ledger = JSON.parse(fs.readFileSync(path.join(ledgerDir, 'requests.json'), 'utf8')); } catch {}
    this.needsObservation = Object.values(this.ledger).some(item => !item.result);
  }
  transfer(text, scope = 'ui') {
    const now = Date.now();
    for (const [key, value] of this.transfers) if (value.expires < now) this.transfers.delete(key);
    if (Buffer.byteLength(text) > MAX_TRANSFER) throw new Error('Image exceeds the 8 MiB transport limit.');
    if (this.transfers.size >= 4) throw new Error('Image transport busy. Wait before refreshing.');
    const token = crypto.randomBytes(16).toString('hex');
    this.transfers.set(token, { text, scope, expires: now + 30000 });
    return { token, chunks: Math.ceil(text.length / CHUNK), length: text.length };
  }
  journal() {
    const entries = Object.entries(this.ledger);
    // Never evict pending/uncertain writes; a full ledger fails closed.
    if (entries.length > 512) throw new Error('Action history full. Review the adapter ledger before further actions.');
    fs.mkdirSync(this.ledgerDir, { recursive: true, mode: 0o700 });
    const target = path.join(this.ledgerDir, 'requests.json');
    const temp = target + '.tmp'; fs.writeFileSync(temp, JSON.stringify(this.ledger), { mode: 0o600 }); fs.renameSync(temp, target);
  }
  async once(id, action, run) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9:-]{8,120}$/.test(id)) throw new Error('Invalid request identity.');
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(action)).digest('hex');
    const old = this.ledger[id];
    if (old && old.fingerprint !== fingerprint) throw new Error('Request identity already used for another action.');
    if (this.actions.has(id)) return this.actions.get(id);
    if (old) {
      if (old.fingerprint !== fingerprint) throw new Error('Request identity already used for another action.');
      if (old.result) return old.result;
      throw new Error('Previous action outcome unknown. Observe before continuing; do not repeat it.');
    }
    // A new epoch is required after restart; old page writes cannot be replayed.
    if (Object.keys(this.ledger).length >= 512) throw new Error('Panel action history full. Review the local requests ledger before clearing it.');
    this.ledger[id] = { fingerprint }; this.journal();
    const promise = run().then(result => {
      // Persist only request hashes and a receipt, never text, selectors, frames or screenshots.
      this.ledger[id].result = { data: { error: { code: 'duplicate_action', message: 'This action already completed. Observe current state; do not repeat it.' } }, isError: true };
      this.journal(); return result;
    });
    this.actions.set(id, promise);
    try { return await promise; } finally { this.actions.delete(id); }
  }
  async mutation(run) {
    if (this.mutating || this.bridge.uncertain || this.needsObservation) throw new Error('Previous phone action is pending or uncertain. Wait for it to finish, then make a fresh observation before further actions.');
    this.mutating = true;
    try { return await run(); } catch (error) { this.needsObservation = true; throw error; } finally { this.mutating = false; }
  }
  async handle(method, p = {}) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('Expected object parameters.');
    if (method === 'adapter/status') {
      const state = process.env.IPHONE_USE_STATE_DIR || process.env.WDA_STATE_DIR ||
        (!fs.existsSync(path.join(os.homedir(), '.local/share/iphone-use')) && fs.existsSync(path.join(os.homedir(), '.local/share/iphone-use-wda/config.json'))
          ? path.join(os.homedir(), '.local/share/iphone-use-wda') : path.join(os.homedir(), '.local/share/iphone-use'));
      return { adapter: '0.1.0', upstream: '0.3.6', epoch: this.epoch, bridge_running: !!this.bridge.child,
        configured: fs.existsSync(path.join(state, 'config.json')), existing_stream_dependencies: fs.existsSync(path.join(state, 'runtime/forward/node_modules/appium-ios-device')),
        platform: process.platform, phone_contacted: false, recovery_enabled: false, polling_ms: 250,
        requirements: 'Existing PUA service; python3 and standalone node on PATH (Homebrew paths included). No setup or installation is automatic.' };
    }
    if (method === 'transport/chunk') {
      const item = this.transfers.get(p.token);
      if (!item || item.scope !== (p.scope || 'ui') || item.expires < Date.now()) { throw new Error('Image transfer expired.'); }
      if (!Number.isInteger(p.index) || p.index < 0 || p.index >= Math.ceil(item.text.length / CHUNK)) throw new Error('Invalid image chunk.');
      return { index: p.index, data: item.text.slice(p.index * CHUNK, (p.index + 1) * CHUNK) };
    }
    if (method === 'transport/release') { if (this.transfers.get(p.token)?.scope === (p.scope || 'ui')) this.transfers.delete(p.token); return { released: true }; }
    if (method === 'ui/frame') {
      const result = await this.bridge.call('pua_screen_frame', { after_seq: p.after_seq || 0, last_event_id: p.last_event_id || 0 }, 5000);
      const data = unpack(result);
      if (result.isError) throw new Error('Preview unavailable. Check the existing PUA connection.');
      return this.transfer(JSON.stringify(data));
    }
    if (method === 'ui/action') {
      if (!['refresh', 'home', 'screenshot', 'pause', 'resume'].includes(p.action)) throw new Error('Unknown panel action.');
      if (p.epoch !== this.epoch) throw new Error('Panel connection changed. Reconnect before a new action; previous outcome may be unknown.');
      if (p.action === 'home' && (this.bridge.uncertain || this.mutating || this.needsObservation)) throw new Error('Phone action outcome unknown. Observe before another Home action.');
      return this.once(p.requestId, { action: p.action }, async () => {
        const name = ['pause', 'resume'].includes(p.action) ? 'pua_screen' : 'pua_screen_action';
        const run = () => this.bridge.call(name, { action: p.action }, 15000);
        const result = p.action === 'home' ? await this.mutation(run) : await run();
        return { data: unpack(result), isError: !!result.isError };
      });
    }
    if (method === 'model/call') {
      if (!MODEL_TOOLS.has(p.name)) throw new Error('Unknown model tool. UI frame and toolbar methods are not model tools.');
      const args = { ...(p.args || {}) };
      if (p.name === 'ready') { if (args.recover === true) throw new Error('Automatic recovery is disabled.'); args.recover = false; args.screenshot ??= false; }
      const run = () => this.bridge.call('pua_' + p.name, args);
      const result = WRITES.has(p.name)
        ? await this.once(p.requestId, { name: p.name, args }, () => p.name === 'screen' && args.action === 'pause' ? run() : this.mutation(run))
        : await run();
      const data = unpack(result);
      if (WRITES.has(p.name) && result.isError) this.needsObservation = true;
      if (['observe', 'ready'].includes(p.name) && !result.isError && !this.bridge.uncertain && !this.mutating && (p.name === 'observe' || data.ready === true)) this.needsObservation = false;
      const image = result.content?.find(item => item.type === 'image');
      let media, image_delivery_error;
      if (image) { try { media = this.transfer(image.data, 'model'); } catch { image_delivery_error = 'Screenshot exceeds transport limits. Read image.path before further actions.'; } }
      return { data, isError: !!result.isError, ...(media ? { media } : {}), ...(image_delivery_error ? { image_delivery_error } : {}) };
    }
    throw new Error('Method not allowed.');
  }
  close() { this.bridge.close(); this.transfers.clear(); }
}
module.exports = { Service, CHUNK, MAX_TRANSFER, MODEL_TOOLS };
