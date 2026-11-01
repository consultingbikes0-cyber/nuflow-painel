// netlify/functions/drive-fotos.js
// Copia as fotos de uma pasta pública do Google Drive (link da planilha da Sense) para o
// armazenamento de fotos do painel (Supabase, bucket bike-photos). Trabalha em lotes para
// caber no tempo limite: o painel chama de novo com "inicio" até "proximo" vir vazio.
//
// Chamada pelo painel: POST /.netlify/functions/drive-fotos
//   corpo: { "id": <id do envio>, "inicio": 0 }
//   cabeçalho: Authorization: Bearer <token de login do painel (Supabase)>
//
// Variável de ambiente no Netlify: GOOGLE_API_KEY (chave do Google Cloud com a Google Drive API ativada)

const SB_URL = 'https://zwoxvbzspdjssuqltgox.supabase.co';
const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp3b3h2YnpzcGRqc3N1cWx0Z294Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY4MDgxNTAsImV4cCI6MjA5MjM4NDE1MH0.IxXj3NhabrA7ln5c_So8u9DXWJ_PlKRgBUav0g4NDNQ';
const LOTE = 4;                                   // fotos por chamada
const TIPOS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }; // formatos que a loja aceita
const MAX_BYTES = 9.5 * 1024 * 1024;              // limite do bucket (10 MB)

function json(status, obj) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { erro: 'Use POST' });
  const chave = (process.env.GOOGLE_API_KEY || '').trim();
  if (!chave) return json(500, { erro: 'GOOGLE_API_KEY não está configurada no Netlify.' });

  // Só quem está logado no painel
  const auth = event.headers.authorization || event.headers.Authorization || '';
  const userToken = auth.replace(/^Bearer\s+/i, '').trim();
  if (!userToken) return json(401, { erro: 'Faça login no painel.' });
  const sbHeaders = { apikey: SB_ANON, Authorization: 'Bearer ' + userToken };
  const quem = await fetch(SB_URL + '/auth/v1/user', { headers: sbHeaders });
  if (!quem.ok) return json(401, { erro: 'Sessão expirada. Entre de novo no painel.' });

  let corpo;
  try { corpo = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { erro: 'Corpo inválido.' }); }
  const id = corpo.id;
  const inicio = Math.max(0, parseInt(corpo.inicio, 10) || 0);
  if (!id) return json(400, { erro: 'Informe o id do envio.' });

  // Lê o envio para pegar o link da pasta
  const rs = await fetch(SB_URL + '/rest/v1/submissoes?select=id,codigo_externo,fotos_link&id=eq.' + encodeURIComponent(id), { headers: sbHeaders });
  const linhas = rs.ok ? await rs.json() : [];
  const b = linhas && linhas[0];
  if (!b) return json(404, { erro: 'Envio não encontrado.' });
  const m = String(b.fotos_link || '').match(/\/folders\/([a-zA-Z0-9_-]+)/) || String(b.fotos_link || '').match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (!m) return json(400, { erro: 'Este anúncio não tem link de pasta do Google Drive.' });
  const pasta = m[1];

  // Lista as imagens da pasta, em ordem de nome
  const q = encodeURIComponent(`'${pasta}' in parents and trashed = false`);
  const lista = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=name_natural&pageSize=200&fields=files(id,name,mimeType,size)&supportsAllDrives=true&includeItemsFromAllDrives=true&key=${chave}`);
  const ld = await lista.json().catch(() => ({}));
  if (!lista.ok) {
    const msg = (ld.error && ld.error.message) || ('HTTP ' + lista.status);
    return json(502, { erro: 'O Google Drive recusou a listagem: ' + msg + '. Confira se a pasta está compartilhada como "Qualquer pessoa com o link".' });
  }
  const todos = ld.files || [];
  const imagens = todos.filter((f) => TIPOS[f.mimeType] && Number(f.size || 0) <= MAX_BYTES);
  const pulados = todos.filter((f) => !TIPOS[f.mimeType] || Number(f.size || 0) > MAX_BYTES)
    .map((f) => f.name + (TIPOS[f.mimeType] ? ' (maior que 10 MB)' : (/^image\//.test(f.mimeType) ? ' (formato ' + f.mimeType.replace('image/', '') + ')' : ' (não é foto)')));
  if (!imagens.length) return json(200, { urls: [], total: 0, proximo: null, pulados });

  // Copia o lote atual para o Supabase
  const pastaDestino = 'sense/' + String(b.codigo_externo || b.id).replace(/[^a-zA-Z0-9_-]/g, '_');
  // Nome sempre novo (com a hora): o armazenamento só permite gravar arquivo novo, não substituir
  const carimbo = Date.now();
  const lote = imagens.slice(inicio, inicio + LOTE);
  const urls = [];
  const falhas = [];
  for (let i = 0; i < lote.length; i++) {
    const f = lote[i];
    const n = inicio + i + 1;
    try {
      const d = await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media&supportsAllDrives=true&key=${chave}`);
      if (!d.ok) throw new Error('download HTTP ' + d.status);
      const bytes = Buffer.from(await d.arrayBuffer());
      const caminho = `${pastaDestino}/${carimbo}_${String(n).padStart(2, '0')}_${f.id}.${TIPOS[f.mimeType]}`;
      const up = await fetch(`${SB_URL}/storage/v1/object/bike-photos/${caminho}`, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': f.mimeType, 'x-upsert': 'false' }, sbHeaders),
        body: bytes,
      });
      if (!up.ok) { const t = await up.text(); throw new Error('upload HTTP ' + up.status + ' ' + t.slice(0, 120)); }
      urls.push(`${SB_URL}/storage/v1/object/public/bike-photos/${caminho}`);
    } catch (e) {
      falhas.push(f.name + ': ' + e.message);
    }
  }
  const proximo = inicio + LOTE < imagens.length ? inicio + LOTE : null;
  return json(200, { urls, total: imagens.length, proximo, pulados: inicio === 0 ? pulados : [], falhas });
};
