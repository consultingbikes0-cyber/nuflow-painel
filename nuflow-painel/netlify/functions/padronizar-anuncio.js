// netlify/functions/padronizar-anuncio.js
// Reorganiza o texto que o vendedor mandou na ficha técnica padrão da Nuflow, usando o Claude.
// Regra principal: NUNCA inventar. Só reorganiza, enxuga e marca upgrades do que já foi escrito.
//
// Chamada pelo painel: POST /.netlify/functions/padronizar-anuncio
//   corpo: { "dados": { marca, modelo, ano, tamanho, tipo, suspensao, shock, freios, relacao, rodas, outros_componentes, observacoes } }
//   cabeçalho: Authorization: Bearer <token de login do painel (Supabase)>
//
// Variável de ambiente no Netlify: ANTHROPIC_API_KEY

const SB_URL = 'https://zwoxvbzspdjssuqltgox.supabase.co';
const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp3b3h2YnpzcGRqc3N1cWx0Z294Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY4MDgxNTAsImV4cCI6MjA5MjM4NDE1MH0.IxXj3NhabrA7ln5c_So8u9DXWJ_PlKRgBUav0g4NDNQ';
const MODELO = 'claude-sonnet-5-5';

const ITENS = [
  ['quadro', 'Quadro'], ['pneus', 'Pneus'], ['canote', 'Canote'], ['cockpit', 'Cockpit'],
  ['motor', 'Motor'], ['bateria', 'Bateria'], ['uso', 'Uso'],
];

const INSTRUCOES = `Você organiza anúncios de bicicletas seminovas premium da Nuflow Bikes. Recebe o que o vendedor escreveu num formulário (muitas vezes bagunçado ou copiado da ficha do fabricante) e devolve a ficha técnica padrão chamando a ferramenta "ficha".

REGRAS OBRIGATÓRIAS
1. Nunca invente. Use só informação que está no texto do vendedor. Se um item não foi informado, devolva "" (vazio). Não complete curso, aro, ano ou modelo de cabeça.
2. Valores curtos e objetivos: marca + modelo + o dado que importa ao comprador. Sem rótulos repetidos dentro do valor ("Câmbio traseiro:", "Alavanca de câmbio:" etc.). Ideal até 60 caracteres.
3. Cada informação vai no item certo, mesmo que o vendedor tenha escrito em outro campo (ex.: pneus citados na condição vão para "pneus" e saem da condição).
4. Upgrade: se o vendedor disser que uma peça é upgrade, foi trocada por uma melhor ou não é original, termine o valor com " (upgrade)". Não marque upgrade sem o vendedor dizer.
5. Português do Brasil correto. Nomes de marcas e modelos como o fabricante escreve.

COMO PREENCHER CADA ITEM
- quadro: material e, se informado, curso traseiro. Ex.: "Carbono, 150mm de curso".
- suspensao (garfo): modelo + curso. Ex.: "Fox 36 Factory 160mm".
- amortecedor: modelo + curso, se informado.
- freios: modelo. Ex.: "Shimano Deore M6120 4 pistões".
- transmissao: só o grupo do câmbio traseiro + número de velocidades. Cite trocador ou cassete apenas se forem upgrade ou de grupo diferente, de forma curta. Nunca inclua movimento central, corrente, medidas ou códigos. Ex.: "SRAM GX Eagle 12v (upgrade), trocador X01 Eagle (upgrade)".
- rodas: modelo + aro, se informado.
- pneus: dianteiro e traseiro de forma curta; se forem novos, diga "novos". Ex.: "Maxxis Assegai 29x2.50 / DHR II 29x2.40, novos".
- canote: modelo e curso, se retrátil. Ex.: "Syncros Duncan Dropper".
- cockpit: guidão + mesa juntos. Ex.: "Guidão Syncros Hixon 1.5 + mesa Syncros FL1.5".
- motor, bateria (Wh), uso (km rodados e ciclos de bateria): só para e-bikes.
- condicao: 1 a 3 frases sobre o estado da bike segundo o vendedor (marcas de uso, arranhões, revisões, peças novas), em terceira pessoa, sem repetir a ficha técnica e sem exagero de marketing. Se o vendedor não falou do estado, devolva "".
- descartados: lista curta do que você tirou da ficha por não interessar ao comprador (ex.: "selim", "movimento central").

DESCARTE SEMPRE: selim, manoplas, pedais, caixa de direção, movimento central, corrente, abraçadeiras, textos de marketing do fabricante, preço.

FORMATO DA RESPOSTA: sempre chame a ferramenta "ficha", sem texto antes ou depois. Se por algum motivo não puder usar a ferramenta, responda apenas com um objeto JSON com os mesmos campos.`;

const FERRAMENTA = {
  name: 'ficha',
  description: 'Devolve a ficha técnica padronizada da bike.',
  input_schema: {
    type: 'object',
    properties: {
      quadro: { type: 'string' }, suspensao: { type: 'string' }, amortecedor: { type: 'string' },
      freios: { type: 'string' }, transmissao: { type: 'string' }, rodas: { type: 'string' },
      pneus: { type: 'string' }, canote: { type: 'string' }, cockpit: { type: 'string' },
      motor: { type: 'string' }, bateria: { type: 'string' }, uso: { type: 'string' },
      condicao: { type: 'string' },
      descartados: { type: 'array', items: { type: 'string' } },
    },
    required: ['quadro', 'suspensao', 'amortecedor', 'freios', 'transmissao', 'rodas', 'pneus', 'canote', 'cockpit', 'motor', 'bateria', 'uso', 'condicao', 'descartados'],
  },
};

function json(status, obj) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(obj) };
}
function limpa(v) { return String(v || '').replace(/\s+/g, ' ').trim().slice(0, 300); }

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { erro: 'Use POST' });
  const chave = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!chave) return json(500, { erro: 'ANTHROPIC_API_KEY não está configurada neste site do Netlify.' });

  // Só quem está logado no painel
  const auth = event.headers.authorization || event.headers.Authorization || '';
  const userToken = auth.replace(/^Bearer\s+/i, '').trim();
  if (!userToken) return json(401, { erro: 'Faça login no painel.' });
  const quem = await fetch(SB_URL + '/auth/v1/user', { headers: { apikey: SB_ANON, Authorization: 'Bearer ' + userToken } });
  if (!quem.ok) return json(401, { erro: 'Sessão expirada. Entre de novo no painel.' });

  let dados;
  try { dados = (JSON.parse(event.body || '{}').dados) || {}; } catch (e) { return json(400, { erro: 'Corpo inválido.' }); }
  const campos = ['marca', 'modelo', 'ano', 'tamanho', 'tipo', 'suspensao', 'shock', 'freios', 'relacao', 'rodas', 'outros_componentes', 'observacoes'];
  const texto = campos.map((c) => c + ': ' + String(dados[c] || '').slice(0, 3000)).join('\n');
  if (!campos.slice(5).some((c) => String(dados[c] || '').trim())) return json(400, { erro: 'Não há componentes nem condição para organizar.' });

  let r;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': chave, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODELO,
        max_tokens: 1500,
        temperature: 0,
        system: INSTRUCOES,
        tools: [FERRAMENTA],
        tool_choice: { type: 'auto' },
        messages: [{ role: 'user', content: 'Texto enviado pelo vendedor (campo: valor):\n\n' + texto + '\n\nResponda chamando a ferramenta "ficha".' }],
      }),
    });
  } catch (e) {
    return json(502, { erro: 'Falha ao falar com a IA: ' + e.message });
  }
  const resp = await r.json().catch(() => ({}));
  if (!r.ok) return json(502, { erro: 'A IA recusou o pedido: ' + ((resp.error && resp.error.message) || ('HTTP ' + r.status)) });
  // Normalmente vem pela ferramenta; se vier como texto, aproveita o JSON do texto
  let f = null;
  const uso = (resp.content || []).find((c) => c.type === 'tool_use' && c.name === 'ficha');
  if (uso && uso.input) f = uso.input;
  else {
    const txt = (resp.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    const m = txt.match(/\{[\s\S]*\}/);
    if (m) { try { f = JSON.parse(m[0]); } catch (e) { f = null; } }
  }
  if (!f || typeof f !== 'object') return json(502, { erro: 'A IA não devolveu a ficha. Tente de novo.' });

  // Converte para os campos do painel
  const extras = ITENS.filter(([k]) => limpa(f[k])).map(([k, rotulo]) => rotulo + ': ' + limpa(f[k]));
  return json(200, {
    campos: {
      suspensao: limpa(f.suspensao),
      shock: limpa(f.amortecedor),
      freios: limpa(f.freios),
      relacao: limpa(f.transmissao),
      rodas: limpa(f.rodas),
      outros_componentes: extras.join('\n'),
      observacoes: String(f.condicao || '').trim().slice(0, 1000),
    },
    descartados: Array.isArray(f.descartados) ? f.descartados.map(limpa).filter(Boolean).slice(0, 10) : [],
  });
};
