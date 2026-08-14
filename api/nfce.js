// api/nfce.js
//
// Função serverless (Vercel) que busca os itens de uma nota fiscal (NFC-e)
// a partir da URL lida no QR code do cupom, e devolve os produtos em JSON
// pro FinPro (index.html) usar.
//
// Por que essa função existe: o site da Fazenda (SEFAZ) de cada estado não
// libera acesso direto de outros sites (bloqueio de CORS), então o
// navegador não consegue buscar a nota sozinho. Essa função roda no
// servidor da Vercel — servidor conversando com servidor não tem esse
// bloqueio — e devolve só o que o app precisa.
//
// IMPORTANTE — leia antes de testar:
// Cada estado brasileiro tem seu próprio site de SEFAZ, com o HTML da nota
// um pouco diferente. O parser abaixo tenta primeiro reconhecer pelo TEXTO
// padronizado nacionalmente do DANFCe ("Qtde.", "UN:", "Vl. Unit.", "Vl.
// Total") — testado e validado contra uma nota real do Paraná — e cai pra
// outros dois formatos (por classe CSS) se esse não bater. Se ainda assim
// não encontrar os itens numa nota de outro estado, me manda o link da nota
// que eu ajusto o parser pro layout específico dele.
//
// Não precisa de nenhuma dependência (package.json) — usa só o que já vem
// pronto no Node da Vercel.

module.exports = async function handler(req, res) {
  // Libera acesso a partir do seu site (GitHub Pages) e de qualquer origem —
  // é só leitura de nota fiscal pública, não tem dado sensível envolvido.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  var nfceUrl = req.query && req.query.url;

  if (!nfceUrl || typeof nfceUrl !== 'string' || !/^https?:\/\//i.test(nfceUrl)) {
    res.status(400).json({ ok: false, error: 'URL da nota inválida.' });
    return;
  }

  try {
    var pageResp = await fetch(nfceUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
      },
      redirect: 'follow'
    });

    if (!pageResp.ok) {
      res.status(502).json({ ok: false, error: 'Não consegui abrir a página da nota (status ' + pageResp.status + ').' });
      return;
    }

    var html = await pageResp.text();
    var parsed = parseNfceHtml(html);

    if (!parsed.items.length) {
      res.status(422).json({ ok: false, error: 'Não encontrei os itens nessa nota. O layout do site desse estado pode ser diferente do esperado — me avise pra eu ajustar.' });
      return;
    }

    res.status(200).json({
      ok: true,
      estabelecimento: parsed.estabelecimento,
      data: parsed.data,
      items: parsed.items
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Erro ao buscar a nota: ' + (err && err.message ? err.message : String(err)) });
  }
};

function decodeEntities(str) {
  return String(str || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTags(str) {
  return decodeEntities(String(str || '').replace(/<[^>]*>/g, ' '));
}

function parseMoney(str) {
  if (!str) return 0;
  var cleaned = String(str).replace(/[^\d,.]/g, '');
  // Formato brasileiro: 1.234,56 -> 1234.56
  if (cleaned.indexOf(',') !== -1) {
    cleaned = cleaned.replace(/\./g, '').replace(',', '.');
  }
  return parseFloat(cleaned) || 0;
}

// Às vezes o "Código: NNN" e o "CNPJ: XX.XXX.XXX/XXXX-XX" do cabeçalho da
// nota acabam grudando no nome do primeiro item por engano — essa função
// limpa esse lixo, mantendo só a parte real do nome do produto.
function cleanItemName(name) {
  var cleaned = name.replace(/^[\s\S]*?(?:CNPJ[:\s]*[\d.\-\/]*|Documento Auxiliar da Nota Fiscal de Consumidor Eletr[oô]nica)\s*/gi, '');
  return (cleaned.trim() || name.trim());
}

// Tenta alguns padrões pra reconhecer os itens da nota. Testado contra uma
// nota real do Paraná (formato nacional padronizado do DANFCe: "Qtde.",
// "UN:", "Vl. Unit.", "Vl. Total") — esse é o Padrão A, tentado primeiro por
// não depender de nenhuma classe CSS específica de estado. Os Padrões B e C
// são reserva pra estados que usem outro layout.
function parseNfceHtml(html) {
  var items = [];
  var fullText = stripTags(html);

  // Corta fora o cabeçalho (nome da loja, CNPJ) antes de procurar itens,
  // usando o título oficial do documento (padronizado nacionalmente) como
  // marco — assim o primeiro item nunca "puxa" nome da loja/CNPJ junto.
  var itemSearchText = fullText;
  var headerMatch = fullText.match(/Documento Auxiliar da Nota Fiscal de Consumidor Eletr[oô]nica|DANFE\s*NFC-?e/i);
  if (headerMatch) itemSearchText = fullText.slice(headerMatch.index + headerMatch[0].length);

  // Padrão A (texto puro, formato nacional do DANFCe)
  var reA = /([^()\n]{2,60}?)\s*\(C[oó]digo:?\s*\d+\)[\s\S]{0,20}?Qtde\.?:?\s*[\d.,]+[\s\S]{0,20}?UN:?\s*\S+[\s\S]{0,25}?Vl\.?\s*Unit\.?:?\s*[\d.,]+[\s\S]{0,40}?Vl\.?\s*Total\s*[\s:]*([\d.,]+)/gi;
  var m;
  while ((m = reA.exec(itemSearchText)) !== null) {
    var name  = cleanItemName(decodeEntities(m[1]));
    var value = parseMoney(m[2]);
    if (name && value > 0) items.push({ name: name, value: value });
  }

  // Padrão B: spans "txtTit" (descrição) seguido de span "valor"
  if (!items.length) {
    var reB = /<span[^>]*class="[^"]*txtTit[^"]*"[^>]*>([\s\S]*?)<\/span>[\s\S]{0,400}?<span[^>]*class="[^"]*valor[^"]*"[^>]*>([\s\S]*?)<\/span>/gi;
    while ((m = reB.exec(html)) !== null) {
      var nameB = stripTags(m[1]);
      var valueB = parseMoney(stripTags(m[2]));
      if (nameB && valueB > 0) items.push({ name: nameB, value: valueB });
    }
  }

  // Padrão C: linhas de tabela <tr id="ItemN"> com nome + "Vl. Total" na mesma linha
  if (!items.length) {
    var reC = /<tr[^>]*id="Item\d+"[^>]*>([\s\S]*?)<\/tr>/gi;
    var rowMatch;
    while ((rowMatch = reC.exec(html)) !== null) {
      var row = rowMatch[1];
      var nameMatch = row.match(/<span[^>]*class="[^"]*txtTit[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
      var valMatch  = row.match(/Vl\.\s*Total[^:]*:\s*<\/span>\s*([\d.,]+)/i) || row.match(/([\d]{1,3}(?:\.\d{3})*,\d{2})/);
      if (nameMatch && valMatch) {
        var n = stripTags(nameMatch[1]);
        var v = parseMoney(valMatch[1]);
        if (n && v > 0) items.push({ name: n, value: v });
      }
    }
  }

  // Estabelecimento: início do texto da página, antes do CNPJ/título do documento
  var estMatch = fullText.match(/^\s*([A-Za-zÀ-ú0-9.,&\s]{3,60}?)\s*(?:CNPJ|Documento Auxiliar)/i);
  var estabelecimento = estMatch ? estMatch[1].trim() : '';
  if (!estabelecimento) {
    // Reserva: layout antigo por classe CSS "txtTopo"
    var estMatch2 = html.match(/<div[^>]*class="[^"]*txtTopo[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    estabelecimento = estMatch2 ? stripTags(estMatch2[1]).split(' - ')[0] : '';
  }

  // Data/hora de emissão — tenta achar pelo rótulo "Emissão:" primeiro (mais
  // confiável, evita pegar outra data da página por engano, tipo Protocolo)
  var dateMatch = fullText.match(/Emiss[ãa]o:?\s*(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2}:\d{2})/i)
               || fullText.match(/(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2}:\d{2})/);
  var data = '';
  if (dateMatch) {
    var parts = dateMatch[1].split('/');
    data = parts[2] + '-' + parts[1] + '-' + parts[0];
  }

  return { items: items, estabelecimento: estabelecimento, data: data };
}
