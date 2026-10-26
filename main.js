(() => {
  'use strict';
  const channel = new BroadcastChannel('iphone-use-panel-ui');
  const uiMethods = new Set(['adapter/status', 'ui/frame', 'ui/action', 'transport/chunk', 'transport/release']);
  const tools = new Set(['ready', 'observe', 'find', 'tap', 'swipe', 'type_text', 'press_button', 'launch_app', 'wait', 'apps', 'screen']);
  const panels = new Map();
  function panelStatus() {
    const now = Date.now();
    return { seen: panels.size > 0, instances: [...panels.values()].map(p => ({ ...p, heartbeat_age_ms: now - p.last_heartbeat_at, connected: now - p.last_heartbeat_at < 15000 })) };
  }
  const pending = new Map();
  const completed = new Map();
  async function node(method, params, callId) {
    const response = await cindy.node.request({ method, params, timeoutMs: method === 'model/call' ? 100000 : 20000, ...(callId ? { callId } : {}) });
    if (!response.ok) throw new Error(response.message || 'Local adapter unavailable. Reopen the panel.');
    return response.result;
  }
  channel.onmessage = async ({ data: message }) => {
    if (!message || message.kind !== 'request' || typeof message.requestId !== 'string' || message.requestId.length > 120) return;
    if (JSON.stringify(message).length > 46000) return;
    if (message.method === 'ui/heartbeat') {
      const p = message.params;
      if (!p || typeof p.panel_id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(p.panel_id)) return;
      // Explicit scalar allowlist: never retain pixels, URLs, error text or frame payloads.
      const item = { panel_id: p.panel_id, source: message.mobilePageId ? 'mobile' : 'desktop', last_heartbeat_at: Date.now() };
      for (const key of ['visible', 'paused', 'image_visible', 'decoded']) item[key] = p[key] === true;
      for (const key of ['natural_width', 'natural_height', 'last_draw_at', 'last_draw_seq', 'last_poll_at', 'error_count']) item[key] = Number.isSafeInteger(p[key]) && p[key] >= 0 ? p[key] : 0;
      item.last_error = ['poll', 'action', 'decode', 'startup', 'runtime'].includes(p.last_error) ? p.last_error : null;
      panels.delete(p.panel_id); panels.set(p.panel_id, item);
      if (panels.size > 8) panels.delete(panels.keys().next().value);
      return;
    }
    if (!uiMethods.has(message.method)) return;
    const key = message.requestId;
    const fingerprint = JSON.stringify([message.method, message.params, message.mobilePageId]);
    const old = completed.get(key) || pending.get(key);
    if (old && old.fingerprint !== fingerprint) return;
    if (completed.has(key)) { channel.postMessage(completed.get(key).response); return; }
    if (pending.has(key)) return;
    if (pending.size >= 16) { channel.postMessage({ kind: 'response', requestId: key, error: 'Adapter busy. Wait for current requests.' }); return; }
    pending.set(key, { fingerprint });
    let response;
    try {
      // The UI cannot send arbitrary tool names, commands, paths or host calls.
      const params = message.method === 'ui/action' ? { action: message.params?.action, epoch: message.params?.epoch, requestId: key }
        : message.method.startsWith('transport/') ? { token: message.params?.token, index: message.params?.index, scope: 'ui' }
        : message.method === 'ui/frame' ? { after_seq: message.params?.after_seq, last_event_id: message.params?.last_event_id } : {};
      response = { kind: 'response', requestId: key, result: await node(message.method, params) };
    } catch (error) { response = { kind: 'response', requestId: key, error: error.message }; }
    pending.delete(key);
    completed.set(key, { fingerprint, response, at: Date.now() });
    for (const [id, item] of completed) if (Date.now() - item.at > 30000 || completed.size > 128) completed.delete(id);
    channel.postMessage(response);
  };
  cindy.onHostMessage(async message => {
    if (message.type !== 'tool-call') return;
    try {
      if (message.tool === 'adapter_status') {
        const result = await node('adapter/status', {}, message.callId);
        delete result.epoch;
        result.panel = panelStatus();
        cindy.send({ type: 'tool-result', callId: message.callId, ok: true, result }); return;
      }
      if (!tools.has(message.tool)) throw new Error('Unknown model tool.');
      const result = await node('model/call', { name: message.tool, args: message.args || {}, requestId: 'model-' + message.callId }, message.callId);
      // Only explicit model observations/failure evidence may enter the media pipeline.
      // UI frames are routed exclusively by BroadcastChannel above.
      const output = { data: result.data, isError: result.isError, ...(result.image_delivery_error ? { image_delivery_error: result.image_delivery_error } : {}) };
      if (result.media) {
        try {
          if (result.media.length > 8 * 1024 * 1024 || result.media.chunks > 342) throw new Error('Screenshot exceeds transfer limit.');
          let encoded = '';
          for (let index = 0; index < result.media.chunks; index++) {
            const chunk = await node('transport/chunk', { token: result.media.token, index, scope: 'model' }, message.callId);
            encoded += chunk.data;
          }
          if (encoded.length !== result.media.length) throw new Error('Screenshot transfer incomplete.');
          const media = await cindy.send({ type: 'cindy-request', kind: 'deposit_media', data: encoded, label: 'iPhone observation', callId: message.callId });
          if (!media.ok || !media.url) throw new Error(media.message || 'Media deposit unavailable.');
          output.xdt_image_urls = [media.url];
          output.image_url = media.url;
        } catch (error) {
          output.image_delivery_error = 'Image delivery failed. Use read on the image.path in this result before further phone actions. ' + error.message;
        } finally {
          await node('transport/release', { token: result.media.token, scope: 'model' }, message.callId).catch(() => {});
        }
      }
      cindy.send({ type: 'tool-result', callId: message.callId, ok: true, result: output });
    } catch (error) {
      cindy.send({ type: 'tool-result', callId: message.callId, ok: false, errorCode: 'ADAPTER_FAILURE', message: error.message });
    }
  });
})();
