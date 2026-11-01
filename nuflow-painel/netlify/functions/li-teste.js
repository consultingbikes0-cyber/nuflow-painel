// netlify/functions/li-teste.js
// TESTE TEMPORÁRIO da API da Loja Integrada. APAGAR depois do teste.
//
// Variáveis de ambiente no Netlify (site do painel):
//   LI_TOKEN        -> personal token da Loja Integrada (só o token, sem "Basic")
//   LI_TESTE_SENHA  -> uma senha qualquer, só para proteger este teste
//
// Uso:
//   Leitura:            ?senha=SUA_SENHA
//   Testar foto em produto JÁ EXISTENTE (não cria produto novo):
//                       ?senha=SUA_SENHA&pid=ID_DO_PRODUTO&foto=URL_DA_FOTO

const BASE = 'https://api.awsli.com.br';

function resposta(status, obj) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(obj, null, 2),
  };
}

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};

  if (!process.env.LI_TESTE_SENHA || q.senha !== process.env.LI_TESTE_SENHA) {
    return resposta(401, { erro: 'Não autorizado' });
  }

  const token = (process.env.LI_TOKEN || '').trim();
  if (!token) return resposta(500, { erro: 'LI_TOKEN não está configurado no Netlify' });

  const headers = {
    Authorization: 'Basic ' + token,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  async function chamar(metodo, caminho, corpo) {
    try {
      const r = await fetch(BASE + caminho, {
        method: metodo,
        headers,
        body: corpo ? JSON.stringify(corpo) : undefined,
      });
      const texto = await r.text();
      let dados;
      try { dados = JSON.parse(texto); } catch { dados = texto.slice(0, 1500); }
      return { status: r.status, dados };
    } catch (e) {
      return { status: 0, dados: String(e) };
    }
  }

  // ---------- MODO FOTO: testa formatos de referência num produto existente ----------
  if (q.pid) {
    if (!q.foto) return resposta(400, { erro: 'Falta o parâmetro foto=URL' });
    const pid = String(q.pid).replace(/\D/g, '');
    const formatos = [
      `/api/v1/produto/${pid}`,
      `/v1/produto/${pid}`,
      Number(pid),
      String(pid),
    ];
    const tentativas = [];
    for (const ref of formatos) {
      const r = await chamar('POST', '/v1/produto_imagem/', {
        produto: ref,
        imagem_url: q.foto,
        principal: true,
        posicao: 0,
      });
      tentativas.push({ formato_produto: ref, status: r.status, resposta: r.dados });
      if (r.status === 200 || r.status === 201) {
        return resposta(200, { resultado: 'FOTO ENVIADA', formato_que_funcionou: ref, tentativas });
      }
    }
    return resposta(200, { resultado: 'NENHUM FORMATO FUNCIONOU', tentativas });
  }

  // ---------- MODO LEITURA ----------
  const out = {};
  const cat = await chamar('GET', '/v1/categoria/?limit=100');
  out['1_autenticacao'] = cat.status === 200 ? 'OK' : `FALHOU (HTTP ${cat.status})`;
  if (cat.status !== 200) out.detalhe = cat.dados;
  return resposta(200, out);
};
