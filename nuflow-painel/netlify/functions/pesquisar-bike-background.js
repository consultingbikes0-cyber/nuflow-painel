// netlify/functions/pesquisar-bike-background.js
// Função em SEGUNDO PLANO (o nome terminado em "-background" faz o Netlify responder 202 na hora
// e deixar a função rodar até 15 minutos). Pesquisa a ficha oficial da bike na internet com o Claude,
// junta com o que o vendedor/planilha informou e grava o resultado no próprio envio (Supabase):
//   ia_status = 'pesquisando' | 'pronto' | 'erro', ia_resultado (json), ia_erro, ia_em.
// O painel acompanha esses campos e preenche a tela de edição quando fica pronto.
//
// Chamada pelo painel: POST /.netlify/functions/pesquisar-bike-background
//   corpo: { "id": <id do envio>, "dados": { campos atuais da tela de edição } }
//   cabeçalho: Authorization: Bearer <token de login do painel (Supabase)>
//
// Variável de ambiente no Netlify: ANTHROPIC_API_KEY

const SB_URL = 'https://zwoxvbzspdjssuqltgox.supabase.co';
const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp3b3h2YnpzcGRqc3N1cWx0Z294Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY4MDgxNTAsImV4cCI6MjA5MjM4NDE1MH0.IxXj3NhabrA7ln5c_So8u9DXWJ_PlKRgBUav0g4NDNQ';
const MODELO = 'claude-sonnet-5-5';
const MAX_RODADAS = 6;

const INSTRUCOES = `Você prepara anúncios de bicicletas premium da Nuflow Bikes (Belo Horizonte), vendidas em todo o Brasil. Recebe os dados de uma bike (informados pelo vendedor ou pela planilha da Sense) e deve:
1. Pesquisar na internet a ficha técnica OFICIAL do modelo e ano exatos. Prefira, nesta ordem: site do fabricante (ex.: sense.com.br, swiftcarbon.com, specialized.com, trekbikes.com, scott-sports.com, canyon.com), depois bancos de especificações confiáveis (ex.: 99spokes.com, bikeinsights.com) e grandes lojas. Faça poucas buscas e objetivas.
2. Devolver tudo chamando a ferramenta "ficha".

REGRAS DE OURO
- O que o vendedor/planilha informou VALE MAIS que a ficha de fábrica: se o vendedor citou uma peça (upgrade, peça trocada, pneus novos), use a dele e termine com " (upgrade)" quando ele disser que é upgrade ou peça melhor que a original.
- A ficha oficial só PREENCHE itens que o vendedor não informou. Nunca invente: se não encontrar a especificação do ano exato com segurança, deixe o item "" e explique em "observacao". Se só achar a de outro ano, use apenas se a fonte deixar claro que o componente não mudou; senão deixe vazio.
- Valores curtos: marca + modelo + dado-chave (curso, nº de velocidades, aro, Wh). Sem rótulos repetidos. Até ~60 caracteres.
- Transmissão: grupo do câmbio + nº de velocidades (ex.: "Shimano Deore XT 12v"). Nada de movimento central, corrente, códigos.
- Cockpit: guidão + mesa juntos. Pneus: dianteiro / traseiro.
- Descarte sempre: selim, manoplas, pedais, caixa de direção, movimento central, corrente, abraçadeiras.
- Português do Brasil. Nada de preço em nenhum campo.

CAMPOS
- tipo: modalidade curta (ex.: "XC", "Trail", "Enduro", "Gravel", "Speed", "Urbana", "E-bike Trail").
- quadro, suspensao (garfo), amortecedor, freios, transmissao, rodas, pneus, canote, cockpit, motor, bateria, uso (km/ciclos, só se informado).
- condicao: 1 a 3 frases sobre o estado da bike SEGUNDO O VENDEDOR/PLANILHA (não use a web aqui), em terceira pessoa, sem exagero.
- abertura: 2 ou 3 frases para abrir o anúncio. Diga para que a bike serve e o que ela tem de melhor, com base na ficha. Tom de especialista confiável, sem exagero, sem preço, sem prometer o que não está na ficha.
- seo_titulo: até 60 caracteres, com marca, modelo, ano e "seminova" (ou "nova" se a condição for nova). Ex.: "Specialized Epic Expert 2022 Seminova Tam M | Nuflow".
- seo_descricao: até 155 caracteres, com os 2 ou 3 componentes mais desejados e "laudo"/"garantia" só se fizer parte dos dados. Sem preço.
- completados_web: nomes dos itens que você preencheu com a ficha oficial (ex.: ["quadro","rodas"]).
- fontes: até 4 páginas que você realmente usou, com titulo e url.
- observacao: uma frase curta com qualquer incerteza (ex.: "Ficha oficial de 2025 não encontrada; usei a de 2024 só para o quadro."). "" se não houver.

FORMATO: termine SEMPRE chamando a ferramenta "ficha" uma única vez.`;

const CAMPOS_FICHA = ['tipo', 'quadro', 'suspensao', 'amortecedor', 'freios', 'transmissao', 'rodas', 'pneus', 'canote', 'cockpit', 'motor', 'bateria', 'uso', 'condicao', 'abertura', 'seo_titulo', 'seo_descricao', 'observacao'];
const propriedades = {};
CAMPOS_FICHA.forEach((k) => { propriedades[k] = { type: 'string' }; });
propriedades.completados_web = { type: 'array', items: { type: 'string' } };
propriedades.fontes = {
  type: 'array',
  items: { type: 'object', properties: { titulo: { type: 'string' }, url: { type: 'string' } }, required: ['titulo', 'url'], additionalProperties: false },
};
const FERRAMENTA_FICHA = {
  name: 'ficha',
  description: 'Devolve a ficha técnica padronizada, a abertura e o SEO do anúncio.',
  strict: true,
  input_schema: { type: 'object', properties: propriedades, required: Object.keys(propriedades), additionalProperties: false },
};
const FERRAMENTA_BUSCA = {
  type: 'web_search_20260318',
  name: 'web_search',
  max_uses: 5,
  allowed_callers: ['direct'],
  user_location: { type: 'approximate', country: 'BR', region: 'Minas Gerais', city: 'Belo Horizonte', timezone: 'America/Sao_Paulo' },
};

function limpa(v, max) { return String(v || '').replace(/\s+/g, ' ').trim().slice(0, max || 300); }

// Converte a resposta da IA nos campos do painel
function paraCamposPainel(f) {
  const itens = [['quadro', 'Quadro'], ['pneus', 'Pneus'], ['canote', 'Canote'], ['cockpit', 'Cockpit'], ['motor', 'Motor'], ['bateria', 'Bateria'], ['uso', 'Uso']];
  const extras = itens.filter(([k]) => limpa(f[k])).map(([k, r]) => r + ': ' + limpa(f[k]));
  return {
    tipo: limpa(f.tipo, 40),
    suspensao: limpa(f.suspensao),
    shock: limpa(f.amortecedor),
    freios: limpa(f.freios),
    relacao: limpa(f.transmissao),
    rodas: limpa(f.rodas),
    outros_componentes: extras.join('\n'),
    observacoes: String(f.condicao || '').trim().slice(0, 1000),
    abertura: String(f.abertura || '').trim().slice(0, 600),
    seo_titulo: limpa(f.seo_titulo, 70),
    seo_descricao: limpa(f.seo_descricao, 170),
  };
}

exports.handler = async (event) => {
  // Função em segundo plano: nunca deixar estourar erro (o Netlify repetiria a chamada)
  let gravar = async () => {};
  try {
    const auth = event.headers.authorization || event.headers.Authorization || '';
    const userToken = auth.replace(/^Bearer\s+/i, '').trim();
    if (!userToken) return;
    const sbHeaders = { apikey: SB_ANON, Authorization: 'Bearer ' + userToken, 'Content-Type': 'application/json', Prefer: 'return=minimal' };
    const quem = await fetch(SB_URL + '/auth/v1/user', { headers: sbHeaders });
    if (!quem.ok) return;

    let corpo = {};
    try { corpo = JSON.parse(event.body || '{}'); } catch (e) { return; }
    const id = corpo.id;
    const dados = corpo.dados || {};
    if (!id) return;

    gravar = async (campos) => {
      await fetch(SB_URL + '/rest/v1/submissoes?id=eq.' + encodeURIComponent(id), {
        method: 'PATCH', headers: sbHeaders, body: JSON.stringify(campos),
      }).catch(() => {});
    };
    await gravar({ ia_status: 'pesquisando', ia_erro: null });

    const chave = (process.env.ANTHROPIC_API_KEY || '').trim();
    if (!chave) { await gravar({ ia_status: 'erro', ia_erro: 'ANTHROPIC_API_KEY não está configurada no Netlify.', ia_em: new Date().toISOString() }); return; }

    const campos = ['marca', 'modelo', 'ano', 'cor', 'tamanho', 'tipo', 'condicao_origem', 'suspensao', 'shock', 'freios', 'relacao', 'rodas', 'outros_componentes', 'observacoes'];
    const texto = campos.map((c) => c + ': ' + String(dados[c] || '').slice(0, 3000)).join('\n');
    const mensagens = [{ role: 'user', content: 'Dados da bike (campo: valor). Pesquise a ficha oficial e devolva a ficha completa:\n\n' + texto }];

    let ficha = null;
    let ultimoErro = '';
    for (let rodada = 0; rodada < MAX_RODADAS && !ficha; rodada++) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': chave, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: MODELO,
          max_tokens: 8000,
          system: INSTRUCOES,
          tools: [FERRAMENTA_BUSCA, FERRAMENTA_FICHA],
          tool_choice: { type: 'auto' },
          messages: mensagens,
        }),
      });
      const resp = await r.json().catch(() => ({}));
      if (!r.ok) { ultimoErro = (resp.error && resp.error.message) || ('HTTP ' + r.status); break; }
      const conteudo = resp.content || [];
      const uso = conteudo.find((c) => c.type === 'tool_use' && c.name === 'ficha');
      if (uso && uso.input) { ficha = uso.input; break; }
      // Continua a conversa (pausa da busca, ou terminou sem chamar a ficha). Este modelo não aceita
      // a conversa terminando numa mensagem do assistente, então sempre segue com uma mensagem do usuário.
      mensagens.push({ role: 'assistant', content: conteudo });
      mensagens.push({ role: 'user', content: resp.stop_reason === 'pause_turn'
        ? 'Continue a pesquisa e, ao terminar, chame a ferramenta "ficha".'
        : 'Agora chame a ferramenta "ficha" com o resultado completo.' });
    }

    if (!ficha) {
      await gravar({ ia_status: 'erro', ia_erro: 'A IA não devolveu a ficha' + (ultimoErro ? ': ' + ultimoErro : '. Tente de novo.'), ia_em: new Date().toISOString() });
      return;
    }

    const resultado = {
      campos: paraCamposPainel(ficha),
      completados_web: Array.isArray(ficha.completados_web) ? ficha.completados_web.map((x) => limpa(x, 40)).filter(Boolean).slice(0, 15) : [],
      fontes: Array.isArray(ficha.fontes) ? ficha.fontes.filter((x) => x && /^https?:\/\//.test(x.url)).slice(0, 4).map((x) => ({ titulo: limpa(x.titulo, 120), url: String(x.url).slice(0, 400) })) : [],
      observacao: limpa(ficha.observacao, 300),
    };
    await gravar({ ia_status: 'pronto', ia_resultado: resultado, ia_erro: null, ia_em: new Date().toISOString() });
  } catch (e) {
    await gravar({ ia_status: 'erro', ia_erro: 'Falha na pesquisa: ' + String(e.message || e).slice(0, 200), ia_em: new Date().toISOString() });
  }
};
