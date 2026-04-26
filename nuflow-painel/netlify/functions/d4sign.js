exports.handler = async function(event) {
  if(event.httpMethod === 'OPTIONS'){
    return { statusCode:200, headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'POST,OPTIONS'}, body:'' };
  }
  if(event.httpMethod !== 'POST') return { statusCode:405, body:'Method Not Allowed' };

  const TOKEN = 'live_a7844d783cfa5c917c439bc61ff80e33547e16928ba6436b10768166fbf774d6';
  const CRYPT = 'live_crypt_reOPJIQuEp8ds5GhUpSeD4Lov2qq7CRD';
  const BASE  = 'https://secure.d4sign.com.br/api/v1';
  const CORS  = { 'Access-Control-Allow-Origin':'*', 'Content-Type':'application/json' };

  const api = async (endpoint, method, body) => {
    const url = `${BASE}${endpoint}?tokenAPI=${TOKEN}&cryptKey=${CRYPT}`;
    const opts = { method: method||'GET', headers:{'Content-Type':'application/json','Accept':'application/json'} };
    if(body) opts.body = JSON.stringify(body);
    const r = await fetch(url, opts);
    const text = await r.text();
    console.log(`[${method||'GET'}] ${endpoint} → ${r.status} →`, text.substring(0,600));
    try { return JSON.parse(text); } catch(e) { return { raw: text }; }
  };

  let payload;
  try { payload = JSON.parse(event.body); }
  catch(e) { return { statusCode:400, headers:CORS, body:JSON.stringify({error:'JSON invalido'}) }; }

  const { action } = payload;

  // ── UPLOAD ──
  if(action === 'upload'){
    const { fileBase64, fileName, cofreUUID } = payload;
    try {
      const boundary = '----NuflowB' + Date.now().toString(36);
      const fileBuffer = Buffer.from(fileBase64, 'base64');
      const partHeader = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/pdf\r\n\r\n`);
      const partClose  = Buffer.from(`\r\n--${boundary}--\r\n`);
      const formBody   = Buffer.concat([partHeader, fileBuffer, partClose]);

      const resp = await fetch(`${BASE}/documents/${cofreUUID}/upload?tokenAPI=${TOKEN}&cryptKey=${CRYPT}`, {
        method:'POST',
        headers:{ 'Content-Type':`multipart/form-data; boundary=${boundary}`, 'Content-Length':String(formBody.length), 'Accept':'application/json' },
        body: formBody
      });
      const text = await resp.text();
      console.log('Upload →', text.substring(0,400));
      let data; try { data=JSON.parse(text); } catch(e){ data={raw:text}; }
      if(!data.uuid) return { statusCode:200, headers:CORS, body:JSON.stringify({error:'Upload falhou', detail:data}) };
      return { statusCode:200, headers:CORS, body:JSON.stringify({uuid:data.uuid}) };
    } catch(e) {
      return { statusCode:500, headers:CORS, body:JSON.stringify({error:e.message}) };
    }
  }

  // ── STATUS ──
  if(action === 'status'){
    const { uuidDoc } = payload;
    try {
      const data = await api(`/documents/${uuidDoc}`, 'GET');
      // Se retornou erro de rate limit ou status=false, ainda não está pronto
      if(data.error || data.status === false) {
        console.log('STATUS: documento ainda processando ou erro:', data.error||'status false');
        return { statusCode:200, headers:CORS, body:JSON.stringify({statusId:'1', ready:false, detail:data}) };
      }
      const raw = data.statusId ?? data.status_id ?? data.statusid ?? data.status ?? null;
      const statusId = raw !== null ? String(raw) : '';
      const ready = statusId !== '' && statusId !== '1' && statusId !== 'false';
      console.log('STATUS FINAL → statusId:', statusId, '| ready:', ready);
      return { statusCode:200, headers:CORS, body:JSON.stringify({statusId, ready, keys:Object.keys(data)}) };
    } catch(e) {
      return { statusCode:500, headers:CORS, body:JSON.stringify({error:e.message}) };
    }
  }

  // ── ASSINAR: cadastra signatários + envia ──
  if(action === 'assinar'){
    const { uuidDoc, signatarios, mensagem } = payload;
    try {
      // type_sign: 2 = assinar sem campo posicionado no PDF
      const signatariosComTipo = signatarios.map(s => ({
        email: s.email,
        act: s.act || '1',
        foreign: s.foreign || '0',
        certificadoicpbr: s.certificadoicpbr || '0',
        assinatura_presencial: '0',
        docauth: '0',
        docauthandselfie: '0',
        embed_methodauth: 'email',
        type_sign: '2',
      }));

      console.log('Enviando signatários:', JSON.stringify(signatariosComTipo));
      const signResp = await api(`/documents/${uuidDoc}/createList`, 'POST', { signers: signatariosComTipo });
      console.log('createList resposta:', JSON.stringify(signResp));

      if(signResp.error) {
        return { statusCode:200, headers:CORS, body:JSON.stringify({error:'Erro ao cadastrar signatários', detail:signResp}) };
      }

      const sendResp = await api(`/documents/${uuidDoc}/sendToSigner`, 'POST', {
        message: mensagem || 'Por favor, assine o documento da Nuflow Bikes.',
        workflow: '0',
        skip_email: '0'
      });
      console.log('sendToSigner resposta:', JSON.stringify(sendResp));

      return { statusCode:200, headers:CORS, body:JSON.stringify({success:true, signResp, sendResp}) };
    } catch(e) {
      return { statusCode:500, headers:CORS, body:JSON.stringify({error:e.message}) };
    }
  }

  // ── REENVIAR ──
  if(action === 'reenviar'){
    const { uuidDoc, email } = payload;
    try {
      const data = await api(`/documents/${uuidDoc}/resend`, 'POST', { email });
      return { statusCode:200, headers:CORS, body:JSON.stringify(data) };
    } catch(e) {
      return { statusCode:500, headers:CORS, body:JSON.stringify({error:e.message}) };
    }
  }

  return { statusCode:400, headers:CORS, body:JSON.stringify({error:'Action desconhecida: '+action}) };
};
