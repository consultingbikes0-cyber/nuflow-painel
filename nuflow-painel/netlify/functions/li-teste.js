// netlify/functions/li-teste.js
// TESTE TEMPORÁRIO da API da Loja Integrada. APAGAR depois do teste.
//
// Variáveis de ambiente no Netlify (site do painel):
//   LI_TOKEN        -> personal token da Loja Integrada (só o token, sem "Basic")
//   LI_TESTE_SENHA  -> uma senha qualquer, só para proteger este teste
//
// Uso:
//   Etapa 1 (só leitura):  /.netlify/functions/li-teste?senha=SUA_SENHA
//   Etapa 2 (cria produto DESATIVADO com 1 foto):
//                          /.netlify/functions/li-teste?senha=SUA_SENHA&criar=1&foto=URL_DA_FOTO

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

  const out = {};

  // ---------- ETAPA 1: autenticação, categorias, marcas, exemplo de produto (só leitura) ----------
  const cat = await chamar('GET', '/v1/categoria/?limit=100');
  out['1_autenticacao'] = cat.status === 200 ? 'OK' : `FALHOU (HTTP ${cat.status})`;
  if (cat.status !== 200) {
    out.detalhe = cat.dados;
    return resposta(200, out);
  }

  out['2_categorias'] = (cat.dados.objects || []).map((c) => ({
    id: c.id,
    nome: c.nome,
    categoria_pai: c.categoria_pai || null,
  }));

  const marcas = await chamar('GET', '/v1/marca/?limit=100');
  out['3_marcas'] = marcas.status === 200
    ? (marcas.dados.objects || []).map((m) => ({ id: m.id, nome: m.nome }))
    : { status: marcas.status, detalhe: marcas.dados };

  // Um produto já existente, para ver o formato exato dos campos
  const lista = await chamar('GET', '/v1/produto/?limit=1');
  const exemplo = lista.status === 200 ? (lista.dados.objects || [])[0] : null;
  out['4_exemplo_produto'] = exemplo || { status: lista.status, detalhe: lista.dados };

  if (exemplo && exemplo.id) {
    const det = await chamar('GET', `/v1/produto/${exemplo.id}/`);
    out['4b_exemplo_produto_detalhe'] = det.dados;
    const imgs = await chamar('GET', `/v1/produto_imagem/?produto=${exemplo.id}`);
    out['4c_exemplo_imagens'] = imgs.dados;
  }

  // ---------- ETAPA 2 (opcional): cria produto de teste DESATIVADO + 1 foto por URL ----------
  if (q.criar === '1') {
    const prod = await chamar('POST', '/v1/produto/', {
      sku: 'TESTE-NUFLOW-' + Date.now(),
      nome: 'TESTE NUFLOW - NAO COMPRAR',
      descricao_completa: '<p>Produto de teste da integração. Pode apagar.</p>',
      ativo: false,
      destaque: false,
      tipo: 'normal',
      usado: true,
      peso: 15,
      altura: 80,
      largura: 25,
      profundidade: 140,
    });
    out['5_criar_produto'] = { status: prod.status, resposta: prod.dados };

    const pid = prod.dados && prod.dados.id;
    if (pid && q.foto) {
      const img = await chamar('POST', '/v1/produto_imagem/', {
        produto: `/api/v1/produto/${pid}/`,
        imagem_url: q.foto,
        principal: true,
        posicao: 1,
      });
      out['6_enviar_foto_por_url'] = { status: img.status, resposta: img.dados };
    }
  }

  return resposta(200, out);
};
