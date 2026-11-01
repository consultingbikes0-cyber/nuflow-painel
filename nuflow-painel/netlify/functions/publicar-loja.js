// netlify/functions/publicar-loja.js
// Publica (ou desativa) um anúncio da Captação na Loja Integrada.
//
// Chamada pelo painel: POST /.netlify/functions/publicar-loja
//   corpo: { "id": <id da submissão>, "acao": "publicar" | "desativar" }
//   cabeçalho: Authorization: Bearer <token de login do painel (Supabase)>
//
// Variáveis de ambiente no Netlify:
//   LI_TOKEN           (obrigatória) personal token da Loja Integrada
//   LI_PUBLICAR_ATIVO  (opcional) "sim" = o anúncio já sai visível no site.
//                      Sem ela, o produto é criado DESATIVADO para conferência no admin da loja.

const LI_BASE = 'https://api.awsli.com.br';
const SB_URL = 'https://zwoxvbzspdjssuqltgox.supabase.co';
// Chave pública (anon) do Supabase: a mesma que já está no painel. Não dá acesso sozinha;
// a leitura/gravação usa o login de quem clicou.
const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp3b3h2YnpzcGRqc3N1cWx0Z294Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY4MDgxNTAsImV4cCI6MjA5MjM4NDE1MH0.IxXj3NhabrA7ln5c_So8u9DXWJ_PlKRgBUav0g4NDNQ';

const CATEGORIA_BRASIL = '/api/v1/categoria/24074516'; // SEMINOVAS > NUFLOW BIKES BRASIL
const CATEGORIA_SENSE = '/api/v1/categoria/24074365';  // SEMINOVAS > SEMINOVAS DE FÁBRICA SENSE
const MAX_FOTOS = 15;
// Medidas da caixa de bike (cm / kg). A loja exige para cálculo de frete.
const CAIXA = { peso: 18, altura: 80, largura: 25, profundidade: 145 };

function json(status, obj) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(obj) };
}

function up(v) { return String(v || '').trim().toUpperCase(); }

// Mesmo padrão dos anúncios da loja: "MARCA MODELO COR - TAMANHO X - ANO - UF"
function tituloLoja(b) {
  const partes = [[up(b.marca), up(b.modelo), up(b.cor)].filter(Boolean).join(' ')];
  if (b.tamanho) partes.push('TAMANHO ' + up(b.tamanho));
  if (b.ano) partes.push(String(b.ano).trim());
  if (b.estado) partes.push(up(b.estado));
  return partes.join(' - ').replace(/\s+/g, ' ').slice(0, 200);
}

function listaFotos(b) {
  let f = b && b.fotos;
  if (typeof f === 'string') { try { f = JSON.parse(f); } catch (e) { f = f.replace(/^\{|\}$/g, '').split(','); } }
  if (!Array.isArray(f)) return [];
  return f.map((u) => String(u || '').trim().replace(/^"|"$/g, '')).filter((u) => /^https:\/\//i.test(u)).slice(0, MAX_FOTOS);
}

function normaliza(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { erro: 'Use POST' });

  const liToken = (process.env.LI_TOKEN || '').trim();
  if (!liToken) return json(500, { erro: 'LI_TOKEN não está configurado no Netlify.' });

  // ---------- 1. Só quem está logado no painel ----------
  const auth = event.headers.authorization || event.headers.Authorization || '';
  const userToken = auth.replace(/^Bearer\s+/i, '').trim();
  if (!userToken) return json(401, { erro: 'Faça login no painel.' });

  const sbHeaders = { apikey: SB_ANON, Authorization: 'Bearer ' + userToken, 'Content-Type': 'application/json' };
  const quem = await fetch(SB_URL + '/auth/v1/user', { headers: sbHeaders });
  if (!quem.ok) return json(401, { erro: 'Sessão expirada. Entre de novo no painel.' });

  let corpo;
  try { corpo = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { erro: 'Corpo inválido.' }); }
  const id = corpo.id;
  const acao = corpo.acao;
  if (!id || (acao !== 'publicar' && acao !== 'desativar')) return json(400, { erro: 'Informe id e acao (publicar ou desativar).' });

  // ---------- 2. Lê o envio ----------
  const rs = await fetch(SB_URL + '/rest/v1/submissoes?select=*&id=eq.' + encodeURIComponent(id), { headers: sbHeaders });
  if (!rs.ok) return json(502, { erro: 'Não consegui ler o envio no Supabase (HTTP ' + rs.status + ').' });
  const linhas = await rs.json();
  const b = Array.isArray(linhas) ? linhas[0] : null;
  if (!b) return json(404, { erro: 'Envio não encontrado.' });

  // ---------- Cliente da Loja Integrada ----------
  const liHeaders = { Authorization: 'Basic ' + liToken, 'Content-Type': 'application/json', Accept: 'application/json' };
  async function li(metodo, caminho, dados) {
    try {
      const r = await fetch(LI_BASE + caminho, { method: metodo, headers: liHeaders, body: dados ? JSON.stringify(dados) : undefined });
      const texto = await r.text();
      let d; try { d = JSON.parse(texto); } catch (e) { d = texto.slice(0, 500); }
      return { ok: r.ok, status: r.status, dados: d };
    } catch (e) {
      return { ok: false, status: 0, dados: String(e) };
    }
  }
  function erroLi(r) {
    const d = r.dados;
    if (d && typeof d === 'object') return (d.error_message || '') + ' ' + JSON.stringify(d.error || d).slice(0, 300);
    return String(d).slice(0, 300);
  }

  const produtoAtual = b.loja_produto_id ? String(b.loja_produto_id).replace(/\D/g, '') : '';

  // ---------- DESATIVAR ----------
  if (acao === 'desativar') {
    if (!produtoAtual) return json(200, { ok: true, aviso: 'Este anúncio não estava na loja.' });
    const r = await li('PUT', '/v1/produto/' + produtoAtual, { ativo: false });
    if (!r.ok && r.status !== 404) return json(502, { erro: 'A loja recusou a desativação: ' + erroLi(r) });
    return json(200, { ok: true, produto_id: Number(produtoAtual), ativo: false });
  }

  // ---------- PUBLICAR ----------
  const preco = Number(b.preco_venda || b.preco_pedido || 0);
  const fotos = listaFotos(b);
  const faltando = [];
  if (!b.marca || !b.modelo) faltando.push('marca e modelo');
  if (!preco) faltando.push('preço no site');
  if (!fotos.length) faltando.push('pelo menos uma foto');
  if (!b.descricao_gerada) faltando.push('descrição (salve ou aprove pelo painel)');
  if (faltando.length) return json(400, { erro: 'Falta: ' + faltando.join(', ') + '.' });

  const ativo = String(process.env.LI_PUBLICAR_ATIVO || '').trim().toLowerCase() === 'sim';
  const avisos = [];

  // Marca: só vincula se já existir na loja com o mesmo nome (não cria marcas novas)
  let marcaUri = null;
  const marcas = await li('GET', '/v1/marca/?limit=500');
  if (marcas.ok && marcas.dados && Array.isArray(marcas.dados.objects)) {
    const alvo = normaliza(b.marca);
    const achou = marcas.dados.objects.find((m) => normaliza(m.nome) === alvo);
    if (achou) marcaUri = '/api/v1/marca/' + achou.id;
    else avisos.push('Marca "' + b.marca + '" não existe na loja; o produto ficou sem marca.');
  }

  const dadosProduto = {
    nome: tituloLoja(b),
    descricao_completa: b.descricao_gerada,
    ativo: ativo,
    // Bikes da Sense marcadas como NOVA na planilha vão como produto novo
    usado: !(b.origem === 'sense' && b.condicao_origem === 'NOVA'),
    categorias: [b.origem === 'sense' ? CATEGORIA_SENSE : CATEGORIA_BRASIL],
    peso: CAIXA.peso,
    altura: CAIXA.altura,
    largura: CAIXA.largura,
    profundidade: CAIXA.profundidade,
  };
  if (marcaUri) dadosProduto.marca = marcaUri;

  let produtoId = '';
  let produtoNovo = false;
  let urlLoja = '';
  let seoUri = '';

  // Já publicado antes: atualiza o mesmo produto (evita duplicar)
  if (produtoAtual) {
    const r = await li('PUT', '/v1/produto/' + produtoAtual, dadosProduto);
    if (r.ok) { produtoId = produtoAtual; urlLoja = (r.dados && r.dados.url) || ''; seoUri = (r.dados && r.dados.seo) || ''; }
    else if (r.status !== 404) return json(502, { erro: 'A loja recusou a atualização: ' + erroLi(r) });
    // 404 = o produto foi apagado no admin da loja; cria de novo abaixo
  }

  if (!produtoId) {
    const sku = 'NFB-' + String(id).replace(/[^a-zA-Z0-9]/g, '').slice(0, 16).toUpperCase();
    const r = await li('POST', '/v1/produto/', Object.assign({ sku: sku, tipo: 'normal' }, dadosProduto));
    if (!r.ok || !r.dados || !r.dados.id) return json(502, { erro: 'A loja recusou a criação do produto: ' + erroLi(r) });
    produtoId = String(r.dados.id);
    produtoNovo = true;
    urlLoja = r.dados.url || '';
    seoUri = r.dados.seo || '';
    if (Array.isArray(r.dados.categorias) && r.dados.categorias.length === 0) {
      avisos.push('A loja não gravou a categoria; confira no admin.');
    }
  }

  // Grava o vínculo já aqui: se algo abaixo falhar, um novo clique atualiza em vez de duplicar
  const salvo = await fetch(SB_URL + '/rest/v1/submissoes?id=eq.' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: Object.assign({ Prefer: 'return=minimal' }, sbHeaders),
    body: JSON.stringify({ loja_produto_id: Number(produtoId), publicado_em: new Date().toISOString() }),
  });
  if (!salvo.ok) avisos.push('Produto criado na loja (ID ' + produtoId + '), mas não consegui gravar o vínculo no painel. Anote o ID.');

  // Preço
  const rp = await li('PUT', '/v1/produto_preco/' + produtoId, { cheio: preco });
  if (!rp.ok) avisos.push('Preço não gravado: ' + erroLi(rp));

  // Estoque: 1 unidade
  const re = await li('PUT', '/v1/produto_estoque/' + produtoId, {
    gerenciado: true, quantidade: 1, situacao_em_estoque: 0, situacao_sem_estoque: -1,
  });
  if (!re.ok) avisos.push('Estoque não gravado: ' + erroLi(re));

  // SEO (título e descrição para o Google). A loja guarda num recurso próprio: /v1/seo/<id>
  let seoOk = false;
  const seoTitulo = String(b.seo_titulo || '').trim() || tituloLoja(b).slice(0, 70);
  const seoDescricao = String(b.seo_descricao || '').trim();
  if (!seoUri) { const pd = await li('GET', '/v1/produto/' + produtoId); seoUri = (pd.dados && pd.dados.seo) || ''; }
  const seoId = String(seoUri).replace(/\/+$/, '').split('/').pop();
  if (seoId && /^\d+$/.test(seoId)) {
    const atual = await li('GET', '/v1/seo/' + seoId);
    if (atual.ok && atual.dados && typeof atual.dados === 'object') {
      const chaves = Object.keys(atual.dados);
      const achar = (opcoes) => opcoes.find((c) => chaves.includes(c));
      const corpoSeo = {};
      const kTitulo = achar(['title', 'titulo', 'seo_title']);
      const kDescricao = achar(['description', 'descricao', 'seo_description']);
      if (kTitulo) corpoSeo[kTitulo] = seoTitulo;
      if (kDescricao && seoDescricao) corpoSeo[kDescricao] = seoDescricao;
      if (Object.keys(corpoSeo).length) {
        const rs = await li('PUT', '/v1/seo/' + seoId, corpoSeo);
        if (rs.ok) seoOk = true; else avisos.push('SEO não gravado: ' + erroLi(rs));
      } else avisos.push('SEO: a loja usa outros nomes de campo (' + chaves.join(', ') + '). Me mande este aviso.');
    } else avisos.push('SEO: não consegui ler o SEO do produto (HTTP ' + atual.status + ').');
  } else avisos.push('SEO: o produto não informou o recurso de SEO.');

  // Fotos: só envia se o produto ainda não tem nenhuma (evita duplicar ao republicar)
  let enviarFotos = produtoNovo;
  if (!produtoNovo) {
    const ri = await li('GET', '/v1/produto_imagem/?produto=' + produtoId + '&limit=1');
    const total = ri.ok && ri.dados && ri.dados.meta ? ri.dados.meta.total_count : null;
    enviarFotos = total === 0;
    if (!enviarFotos) avisos.push('Fotos não foram reenviadas (o produto já tem fotos). Para trocar, ajuste no admin da loja.');
  }
  let fotosOk = 0;
  const enviarFoto = (url, pos) => li('POST', '/v1/produto_imagem/', {
    produto: '/api/v1/produto/' + produtoId,
    imagem_url: url,
    principal: pos === 0,
    posicao: pos,
  });
  if (enviarFotos) {
    // 1) A capa vai sozinha e primeiro, para a loja registrá-la como foto principal
    const capa = await enviarFoto(fotos[0], 0);
    if (capa.ok) fotosOk++;
    else avisos.push('Foto 1 (capa) não enviada: ' + erroLi(capa));
    // 2) As demais em lotes de 3, para caber no tempo limite da função
    for (let i = 1; i < fotos.length; i += 3) {
      const res = await Promise.all(fotos.slice(i, i + 3).map((url, j) => enviarFoto(url, i + j)));
      res.forEach((r, j) => {
        if (r.ok) fotosOk++;
        else avisos.push('Foto ' + (i + j + 1) + ' não enviada: ' + erroLi(r));
      });
    }
  }

  // Confere a capa: se o produto ficou sem foto principal, marca a de menor posição
  const ri2 = await li('GET', '/v1/produto_imagem/?produto=' + produtoId + '&limit=50');
  const imagens = (ri2.ok && ri2.dados && Array.isArray(ri2.dados.objects)) ? ri2.dados.objects : [];
  if (imagens.length && !imagens.some((x) => x.principal === true || x.principal === 'true')) {
    const primeira = imagens.slice().sort((a, b) => Number(a.posicao) - Number(b.posicao))[0];
    const rp = await li('PUT', '/v1/produto_imagem/' + primeira.id, { principal: true });
    if (!rp.ok) avisos.push('A loja ficou sem foto de capa e não consegui marcar automaticamente (' + erroLi(rp) + '). Marque a capa no admin da loja.');
  }

  return json(200, {
    ok: true,
    produto_id: Number(produtoId),
    novo: produtoNovo,
    ativo: ativo,
    url: urlLoja,
    fotos_enviadas: fotosOk,
    seo: seoOk,
    avisos: avisos,
  });
};
