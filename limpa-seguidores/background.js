// Baixa fotos de perfil do CDN do Instagram e devolve como data URL,
// para quando o navegador bloqueia a imagem direto na página.
const ALLOWED = /^https:\/\/[^/]+\.(cdninstagram\.com|fbcdn\.net)\//;

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'img' || !ALLOWED.test(msg.url || '')) return;
  fetch(msg.url)
    .then(async (r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const type = r.headers.get('content-type') || 'image/jpeg';
      return 'data:' + type + ';base64,' + toBase64(await r.arrayBuffer());
    })
    .then(sendResponse, () => sendResponse(null));
  return true;
});
