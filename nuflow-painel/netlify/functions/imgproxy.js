exports.handler = async function(event) {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  };

  if(event.httpMethod === 'OPTIONS'){
    return { statusCode: 200, headers: CORS, body: '' };
  }

  // URL da imagem vem via query string ou body
  let imgUrl = '';
  if(event.httpMethod === 'GET'){
    imgUrl = event.queryStringParameters?.url || '';
  } else {
    try { imgUrl = JSON.parse(event.body||'{}').url || ''; } catch(e){}
  }

  if(!imgUrl){
    return { statusCode: 400, headers: CORS, body: JSON.stringify({error:'URL não fornecida'}) };
  }

  // Segurança: só permite URLs do Firebase Storage da Nuflow
  if(!imgUrl.includes('firebasestorage.googleapis.com') && !imgUrl.includes('nuflow')){
    return { statusCode: 403, headers: CORS, body: JSON.stringify({error:'URL não permitida'}) };
  }

  try {
    const response = await fetch(imgUrl);
    if(!response.ok){
      return { statusCode: response.status, headers: CORS, body: JSON.stringify({error:'Falha ao buscar imagem: '+response.status}) };
    }

    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    const contentType = response.headers.get('content-type') || 'image/jpeg';

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
      body: JSON.stringify({ base64, contentType, dataUrl: `data:${contentType};base64,${base64}` })
    };
  } catch(e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({error: e.message}) };
  }
};
