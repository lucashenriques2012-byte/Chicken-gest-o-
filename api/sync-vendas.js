// ============================================================
// Integração Cardápio Web (Open Delivery) → Chicken Point Gestão
// Roda automaticamente todo dia (cron da Vercel) e também pelo
// botão "Puxar vendas agora" dentro do app.
//
// ⚠️ SEGURANÇA: as credenciais NÃO ficam neste arquivo.
// Elas são lidas das Environment Variables da Vercel:
//   CW_CLIENT_ID     → ID do estabelecimento (Cardápio Web)
//   CW_CLIENT_SECRET → Segredo do estabelecimento (Cardápio Web)
//   CW_BASE_URL      → (opcional) URL base da API
// ============================================================

const BASE = process.env.CW_BASE_URL || "https://integracao.cardapioweb.com/api/open_delivery";
const CID = process.env.CW_CLIENT_ID;
const CSEC = process.env.CW_CLIENT_SECRET;

// Banco do app (a chave anon é pública por design — a mesma usada no app)
const SB_URL = "https://goueultbbufbzvcbfftr.supabase.co/rest/v1/dados";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdvdWV1bHRiYnVmYnp2Y2JmZnRyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM2OTgzMDMsImV4cCI6MjA5OTI3NDMwM30.BT_tw5xLAE_vEZCVU37qwkKFneQdFOcKgU-4oMJb2P0";
const SB_CAB = { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY };

const uid = () => Math.random().toString(36).slice(2, 10);

// Data do pedido no fuso de Brasília (YYYY-MM-DD)
function dataBRT(iso) {
  const d = iso ? new Date(iso) : new Date();
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(d);
}

// Identifica o canal do pedido (iFood / 99Food / Keeta / próprio)
function canalDe(pedido) {
  const texto = JSON.stringify(pedido).toLowerCase();
  if (texto.includes("ifood")) return "ifood";
  if (texto.includes("keeta")) return "keeta";
  if (texto.includes("99food") || texto.includes("99 food")) return "food99";
  return "proprio";
}

// Extrai o valor total do pedido (cobre as variações do padrão Open Delivery)
function valorDe(pedido) {
  const t = pedido.total || {};
  return Number(
    (t.orderAmount && t.orderAmount.value) ??
    t.orderAmount ?? t.value ?? pedido.orderAmount ?? pedido.totalPrice ?? 0
  ) || 0;
}

// Autentica no Cardápio Web — tenta o fluxo padrão Open Delivery
async function obterToken() {
  const corpo = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: CID,
    client_secret: CSEC,
  });
  for (const url of [BASE + "/v1/oauth/token", BASE + "/oauth/token", BASE + "/v1/auth/token"]) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: corpo.toString(),
      });
      if (r.ok) {
        const j = await r.json();
        const tk = j.accessToken || j.access_token || j.token;
        if (tk) return { tipo: "Bearer", valor: tk };
      }
    } catch (e) { /* tenta a próxima URL */ }
  }
  // Fallback: autenticação Basic direto nas chamadas
  return { tipo: "Basic", valor: Buffer.from(CID + ":" + CSEC).toString("base64") };
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  try {
    if (!CID || !CSEC) {
      return res.status(500).json({ ok: false, erro: "Credenciais não configuradas. Adicione CW_CLIENT_ID e CW_CLIENT_SECRET nas Environment Variables da Vercel." });
    }

    const auth = await obterToken();
    const CAB = {
      Authorization: auth.tipo + " " + auth.valor,
      "X-Client-Id": CID,
      "Content-Type": "application/json",
    };

    // 1) Busca eventos novos (pedidos que chegaram desde a última consulta)
    const rEv = await fetch(BASE + "/v1/events:polling", { headers: CAB });
    if (rEv.status === 204) {
      return res.status(200).json({ ok: true, msg: "Nenhum pedido novo desde a última sincronização." });
    }
    if (!rEv.ok) {
      const detalhe = await rEv.text().catch(() => "");
      return res.status(200).json({ ok: false, erro: "Cardápio Web recusou a consulta (HTTP " + rEv.status + ").", detalhe: detalhe.slice(0, 400) });
    }
    const eventos = await rEv.json();
    const lista = Array.isArray(eventos) ? eventos : (eventos.items || eventos.events || []);
    if (!lista.length) {
      return res.status(200).json({ ok: true, msg: "Nenhum pedido novo desde a última sincronização." });
    }

    // 2) Carrega os dados atuais do app (pra não duplicar pedidos já contados)
    const rSb = await fetch(SB_URL + "?id=eq.1&select=conteudo", { headers: SB_CAB });
    const jSb = await rSb.json();
    const conteudo = (jSb[0] && jSb[0].conteudo) || {};
    conteudo.vendas = conteudo.vendas || [];
    conteudo.pedidosProcessados = conteudo.pedidosProcessados || [];
    const jaProcessados = new Set(conteudo.pedidosProcessados);

    // 3) Busca os detalhes de cada pedido e soma por dia/canal
    const porDia = {};
    let pedidosNovos = 0, totalNovo = 0;
    const cancelado = (s) => String(s || "").toUpperCase().includes("CANCEL");
    const idsPedidos = [...new Set(lista.map(e => e.orderId || e.order_id || (e.order && e.order.id)).filter(Boolean))];

    for (const orderId of idsPedidos) {
      if (jaProcessados.has(orderId)) continue;
      let pedido = null;
      try {
        const rP = await fetch(BASE + "/v1/orders/" + orderId, { headers: CAB });
        if (rP.ok) pedido = await rP.json();
      } catch (e) { /* pula este pedido */ }
      if (!pedido || cancelado(pedido.status)) { jaProcessados.add(orderId); continue; }

      const valor = valorDe(pedido);
      if (valor <= 0) { jaProcessados.add(orderId); continue; }
      const dia = dataBRT(pedido.createdAt || pedido.created_at);
      const canal = canalDe(pedido);
      porDia[dia] = porDia[dia] || { faturamento: 0, pedidos: 0, canais: { proprio: 0, ifood: 0, food99: 0, keeta: 0 } };
      porDia[dia].faturamento += valor;
      porDia[dia].pedidos += 1;
      porDia[dia].canais[canal] += valor;
      jaProcessados.add(orderId);
      pedidosNovos++;
      totalNovo += valor;
    }

    // 4) Junta com o que já existe no app (registros automáticos do mesmo dia se somam)
    for (const [dia, dados] of Object.entries(porDia)) {
      const existente = conteudo.vendas.find(v => v.data === dia && v.origem === "auto");
      if (existente) {
        existente.faturamento = Number(existente.faturamento || 0) + dados.faturamento;
        existente.pedidos = Number(existente.pedidos || 0) + dados.pedidos;
        existente.canais = existente.canais || { proprio: 0, ifood: 0, food99: 0, keeta: 0 };
        for (const c of Object.keys(dados.canais)) {
          existente.canais[c] = Number(existente.canais[c] || 0) + dados.canais[c];
        }
      } else {
        conteudo.vendas.push({ id: uid(), data: dia, origem: "auto", ...dados });
      }
    }
    conteudo.pedidosProcessados = [...jaProcessados].slice(-800); // guarda os últimos, evita crescer pra sempre

    // 5) Salva no banco do app
    const rSave = await fetch(SB_URL + "?id=eq.1", {
      method: "PATCH",
      headers: { ...SB_CAB, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ conteudo }),
    });
    if (!rSave.ok) {
      return res.status(200).json({ ok: false, erro: "Consegui ler os pedidos mas falhei ao salvar no banco (HTTP " + rSave.status + ")." });
    }

    // 6) Confirma o recebimento dos eventos pro Cardápio Web (pra não virem de novo)
    try {
      const acks = lista.map(e => ({ id: e.eventId || e.id })).filter(a => a.id);
      if (acks.length) {
        await fetch(BASE + "/v1/events/acknowledgment", {
          method: "POST",
          headers: CAB,
          body: JSON.stringify(acks),
        });
      }
    } catch (e) { /* se falhar, a checagem de duplicados segura */ }

    const dias = Object.keys(porDia).length;
    return res.status(200).json({
      ok: true,
      msg: pedidosNovos
        ? pedidosNovos + " pedido(s) novos, R$ " + totalNovo.toFixed(2).replace(".", ",") + " em " + dias + " dia(s)."
        : "Nenhum pedido novo pra contabilizar.",
    });
  } catch (e) {
    return res.status(200).json({ ok: false, erro: "Erro inesperado na integração.", detalhe: String(e).slice(0, 300) });
  }
};
