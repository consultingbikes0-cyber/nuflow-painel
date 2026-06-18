exports.handler = async function(event) {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST,OPTIONS'
  };

  if(event.httpMethod === 'OPTIONS'){
    return { statusCode: 200, headers: CORS, body: '' };
  }

  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, headers: CORS, body: JSON.stringify({error:'Método não permitido'}) };
  }

  let texto = '';
  try {
    const body = JSON.parse(event.body || '{}');
    texto = (body.texto || '').trim();
  } catch(e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({error:'Body inválido'}) };
  }

  if(!texto){
    return { statusCode: 400, headers: CORS, body: JSON.stringify({error:'Texto vazio'}) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if(!apiKey){
    console.error('ANTHROPIC_API_KEY não configurada no Netlify');
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ textoFormal: texto, aviso: 'API key não configurada — texto original mantido' }) };
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: `Reescreva o texto abaixo em tom jurídico-formal, adequado para constar como cláusula adicional em um contrato de compra/venda ou consignação de bicicleta usada. Mantenha todas as informações factuais exatamente como estão (valores, prazos, nomes, condições) — apenas ajuste a linguagem para ser formal e juridicamente apropriada. Não adicione informações que não estejam no texto original. Responda APENAS com o texto reescrito, sem introduções, explicações, comentários ou aspas.\n\nTexto original:\n"${texto}"`
        }]
      })
    });

    if(!response.ok){
      const errBody = await response.text();
      console.error('Erro Anthropic API:', response.status, errBody);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ textoFormal: texto, aviso: 'Erro na API — texto original mantido' }) };
    }

    const data = await response.json();
    const textBlock = (data.content || []).find(b => b.type === 'text');
    const textoFormal = textBlock ? textBlock.text.trim() : texto;

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ textoFormal }) };
  } catch(e) {
    console.error('Erro ao chamar Anthropic:', e);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ textoFormal: texto, aviso: e.message }) };
  }
};
