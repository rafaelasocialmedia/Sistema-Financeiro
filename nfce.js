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
// um pouco diferente. O parser abaixo cobre o padrão mais comum (baseado no
// leiaute de referência usado por vários estados: classes "txtTit" pro nome
// do produto e "valor" pro preço). Se ao testar com uma nota real ele não
// encontrar os itens, me manda o link da nota (ou o HTML da página) que eu
// ajusto o parser pro layout do seu estado especificamente.
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

// Tenta alguns padrões comuns usados pelas páginas de NFC-e dos estados.
// Se um estado tiver um layout muito diferente, os padrões abaixo podem
// retornar 0 itens — nesse caso o app avisa a Ebon com uma mensagem clara.
function parseNfceHtml(html) {
  var items = [];

  // Padrão 1: spans "txtTit" (descrição) seguido de span "valor" (o mais comum)
  var re1 = /<span[^>]*class="[^"]*txtTit[^"]*"[^>]*>([\s\S]*?)<\/span>[\s\S]{0,400}?<span[^>]*class="[^"]*valor[^"]*"[^>]*>([\s\S]*?)<\/span>/gi;
  var m;
  while ((m = re1.exec(html)) !== null) {
    var name  = stripTags(m[1]);
    var value = parseMoney(stripTags(m[2]));
    if (name && value > 0) items.push({ name: name, value: value });
  }

  // Padrão 2: linhas de tabela <tr id="ItemN"> com nome + "Vl. Total" na mesma linha
  if (!items.length) {
    var re2 = /<tr[^>]*id="Item\d+"[^>]*>([\s\S]*?)<\/tr>/gi;
    var rowMatch;
    while ((rowMatch = re2.exec(html)) !== null) {
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

  // Estabelecimento (heurística — nem todo estado usa a mesma marcação)
  var estMatch = html.match(/<div[^>]*class="[^"]*txtTopo[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  var estabelecimento = estMatch ? stripTags(estMatch[1]).split(' - ')[0] : '';

  // Data/hora de emissão
  var dateMatch = html.match(/(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2}:\d{2})/);
  var data = '';
  if (dateMatch) {
    var parts = dateMatch[1].split('/');
    data = parts[2] + '-' + parts[1] + '-' + parts[0];
  }

  return { items: items, estabelecimento: estabelecimento, data: data };
}
